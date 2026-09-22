import { create } from "zustand";

import type {
	AuthorUpdate,
	BookUpdate,
	CoverThumbnail,
	ImportableBookMetadata,
	LibraryAuthor,
	LibraryBook,
	LibrarySeries,
	NewAuthor,
} from "@/bindings";
import { commands } from "@/bindings";
import {
	ALL_BOOKS_FILTER,
	advanceSnapshot,
	applyBookPage,
	BOOK_PAGE_SIZE,
	type BookGridFilter,
	type BookSnapshot,
	cacheForKey,
	compareBySeriesIndex,
	emptyBookCache,
	invalidateBookCache,
	type PagedBookCache,
	pagesCoveringRange,
	serializeBookFilter,
	toBookQuery,
} from "@/lib/book-page-cache";
import { sortAuthors } from "@/lib/domain/author";
import type { Library, Options } from "@/lib/services/library";
import { initClient } from "@/lib/services/library";

export enum LibraryState {
	uninitialized = "uninitialized",
	initializing = "initializing",
	ready = "ready",
	error = "error",
}

interface LibraryActions {
	// Core actions
	loadAuthors: () => Promise<void>;
	loadSeries: () => Promise<void>;
	initialize: (libraryPath: string) => Promise<void>;
	reset: () => void;

	// Paged book grid
	/**
	 * Points the paged cache at a new filter combination. A changed key swaps
	 * in an empty cache (next generation); pages are then fetched on demand
	 * by `ensureBookRange`.
	 */
	setBookFilter: (filter: BookGridFilter) => void;
	/**
	 * Fetches whichever pages covering the inclusive item-index range
	 * [start, end] are missing from the current cache. Overlapping calls
	 * de-dupe in flight; results only land while their cache key and
	 * generation are still current.
	 */
	ensureBookRange: (start: number, end: number) => Promise<void>;
	/**
	 * After a mutation: drops all cached pages (visible ones refetch lazily),
	 * marks the full list stale, and refreshes the series list and the
	 * unfiltered library total.
	 */
	invalidateBooks: () => void;

	// Library management
	createLibrary: (libraryRoot: string) => Promise<void>;
	listValidFileTypes: () => Promise<string[]>;
	getImportableBookMetadata: (
		filePath: string,
	) => Promise<ImportableBookMetadata | undefined>;
	commitAddBook: (
		metadata: ImportableBookMetadata,
	) => Promise<string | undefined>;

	// Book and author mutations
	updateBook: (bookId: string, updates: BookUpdate) => Promise<void>;
	updateAuthor: (authorId: string, updates: AuthorUpdate) => Promise<void>;
	createAuthors: (newAuthors: NewAuthor[]) => Promise<void>;
	deleteAuthor: (authorId: string) => Promise<void>;
	deleteBookIdentifier: (bookId: string, identifierId: number) => Promise<void>;
	upsertBookIdentifier: (
		bookId: string,
		identifierId: number | null,
		label: string,
		value: string,
	) => Promise<void>;
	addBook: (metadata: ImportableBookMetadata) => Promise<string | undefined>;
}

interface LibraryStoreState {
	// Library instance
	library: Library | null;
	libraryState: LibraryState;
	libraryError: Error | null;
	/**
	 * Path of the library the current visible generation belongs to — set
	 * atomically at the flip, never during a shadow load. The UI derives
	 * "which library am I looking at" from this instead of the settings
	 * store's instantly-updated activeLibraryId.
	 */
	confirmedLibraryPath: string | null;

	// Paged book grid state
	bookFilter: BookGridFilter;
	bookCache: PagedBookCache;
	bookPagesError: string | null;
	/**
	 * Last successfully resolved query snapshot. Kept across key changes so the
	 * grid can show stale results while the new query is in flight (stale-while-
	 * revalidate), avoiding a blank flash on every debounced keystroke.
	 */
	staleBookSnapshot: BookSnapshot | null;
	/**
	 * Grid-sized cover thumbnails by book id, requested in the background as
	 * each page of books lands. The grid renders these instead of decoding
	 * full-resolution covers.
	 */
	coverThumbs: ReadonlyMap<LibraryBook["id"], CoverThumbnail>;
	/** Unfiltered library size (for "N of M books"); null until known. */
	libraryTotal: number | null;
	/**
	 * True once the open-time thumbnail seed (the cheap index read) has landed
	 * for the current library. The first-run flow's "Preparing covers" stage
	 * holds until this flips; background thumbnail generation continues after.
	 */
	coversSeeded: boolean;

	// Authors state
	authors: LibraryAuthor[];
	authorsLoading: boolean;
	authorsError: string | null;

	// Series state
	series: LibrarySeries[];
	seriesLoading: boolean;
	seriesError: string | null;

	// Stable actions object containing ALL actions
	actions: LibraryActions;
}

const initialState = {
	library: null,
	libraryState: LibraryState.uninitialized,
	libraryError: null,
	confirmedLibraryPath: null,
	bookFilter: ALL_BOOKS_FILTER,
	bookCache: emptyBookCache(serializeBookFilter(ALL_BOOKS_FILTER), 0),
	bookPagesError: null,
	staleBookSnapshot: null as BookSnapshot | null,
	coverThumbs: new Map<LibraryBook["id"], CoverThumbnail>(),
	libraryTotal: null,
	coversSeeded: false,
	authors: [],
	authorsLoading: false,
	authorsError: null,
	series: [],
	seriesLoading: false,
	seriesError: null,
};

const localLibraryFromPath = (path: string): Options => ({
	libraryPath: path,
	libraryType: "calibre",
	connectionType: "local",
});

// In-flight de-dupe (module scope: promises are not store state).
const inFlightBookPages = new Map<string, Promise<void>>();
// Book ids whose thumbnails have been requested (in flight or landed), so a
// page refetch doesn't re-ask. Cleared on invalidation: re-asking is cheap
// (the backend cache answers by cover mtime) and picks up replaced covers.
const requestedThumbIds = new Set<string>();

// Shadow-switch machinery (module scope: non-reactive coordination).
//
// A switch loads the target library into a SHADOW generation while the old
// content stays rendered: `initClient` + authors/series/total + first page
// all resolve into locals, and only a fully-loaded shadow commits (the
// flip). `pendingSwitch` identifies the one shadow allowed to flip; every
// other async commit site checks `canCommitActive`, so results fetched for
// a superseded library (or during a pending shadow, when the backend global
// may already point at the target) can never land in visible state.
let shadowTokenCounter = 0;
let pendingSwitch: { token: number; path: string } | null = null;
// A cancelled or failed switch re-opens the confirmed library, but the
// backend global keeps pointing elsewhere until that open resolves. The
// restore token holds the same guard as a pending shadow for that window,
// so no read or mutation reaches the wrong library in between.
let pendingRestore: number | null = null;
// The backend holds ONE global library; `initClient` swaps it. Opens are
// serialized so a cancel's restore cannot race a superseded shadow's open
// (last call in the chain always wins the global, in call order).
let backendOpenChain: Promise<unknown> = Promise.resolve();

const SWITCH_IN_PROGRESS_ERROR = "A library switch is in progress";

/** The backend global may not match the visible library: a shadow switch is
 * loading, or a cancelled/failed switch is still restoring. */
const isBackendDiverted = (): boolean =>
	pendingSwitch !== null || pendingRestore !== null;

const openBackend = (libraryPath: string): Promise<Library> => {
	const open = backendOpenChain.then(() =>
		initClient(localLibraryFromPath(libraryPath)),
	);
	backendOpenChain = open.catch(() => undefined);
	return open;
};

interface Settled<T> {
	value: T | null;
	error: string | null;
}

/** Resolves a shadow-load fact without failing the whole load: value +
 * error message, mirroring how `loadAuthors`/`loadSeries` isolate failures. */
const settleWithMessage = async <T>(
	promise: Promise<T>,
	fallback: string,
): Promise<Settled<T>> => {
	try {
		return { value: await promise, error: null };
	} catch (error) {
		return {
			value: null,
			error: error instanceof Error ? error.message : fallback,
		};
	}
};

export const useLibraryStore = create<LibraryStoreState>((set, get) => {
	/**
	 * Whether an async result captured under `generation` may still commit to
	 * the ACTIVE state. Dead while the backend is diverted (a pending shadow
	 * or restore — the global may point at another library) or once a later
	 * generation owns the cache (flip, filter change, invalidation, reset).
	 */
	const canCommitActive = (generation: number): boolean =>
		!isBackendDiverted() && generation === get().bookCache.generation;

	/**
	 * Re-points the backend global at the confirmed library after a cancelled
	 * or failed switch, holding the diverted guard until the open resolves.
	 * Fetches were refused (and in-flight answers discarded) meanwhile, so a
	 * successful restore bumps the generation — loaded pages stay, and the
	 * grid refetches only the ones it's missing.
	 */
	const restoreBackend = (libraryPath: string): void => {
		const token = ++shadowTokenCounter;
		pendingRestore = token;
		openBackend(libraryPath).then(
			() => {
				if (pendingRestore !== token) return;
				pendingRestore = null;
				if (pendingSwitch !== null) return;
				set((state) => ({
					bookCache: {
						...state.bookCache,
						generation: state.bookCache.generation + 1,
					},
				}));
			},
			(error: unknown) => {
				if (pendingRestore !== token) return;
				pendingRestore = null;
				console.error("Failed to restore the active library backend:", error);
				if (pendingSwitch !== null) return;
				set({
					libraryError:
						error instanceof Error ? error : new Error(String(error)),
				});
			},
		);
	};

	const mergeCoverThumbs = (
		thumbs: CoverThumbnail[],
		generation: number,
	): void => {
		if (thumbs.length === 0) return;
		if (!canCommitActive(generation)) return;
		set((state) => {
			const next = new Map(state.coverThumbs);
			for (const thumb of thumbs) next.set(thumb.book_id, thumb);
			return { coverThumbs: next };
		});
	};

	/**
	 * Fire-and-forget thumbnail fetch for freshly landed page items. Failures
	 * un-mark the ids so a later page fetch retries; the grid just keeps its
	 * fallback rendering in the meantime. Skipped entirely while a shadow
	 * switch is pending: the requests would race the backend swap.
	 */
	const ensureCoverThumbs = (books: LibraryBook[]): void => {
		if (isBackendDiverted()) return;
		const { library } = get();
		if (!library) return;
		const generation = get().bookCache.generation;
		const wanted = books
			.filter(
				(book) => book.cover_image !== null && !requestedThumbIds.has(book.id),
			)
			.map((book) => book.id);
		if (wanted.length === 0) return;
		for (const id of wanted) requestedThumbIds.add(id);

		void library
			.ensureCoverThumbnails(wanted)
			.then((thumbs) => mergeCoverThumbs(thumbs, generation))
			.catch((error: unknown) => {
				for (const id of wanted) requestedThumbIds.delete(id);
				console.error("Failed to load cover thumbnails:", error);
			});
	};

	/**
	 * Instant-paint warm path, run once per library open: seed every already
	 * known thumbnail (cheap index read), then generate the rest of the
	 * library's thumbnails in the background. After this lands, ANY scroll
	 * offset paints placeholders the frame its rows mount.
	 */
	const warmCoverThumbs = async (): Promise<void> => {
		const { library } = get();
		const generation = get().bookCache.generation;
		if (!library) {
			if (canCommitActive(generation)) set({ coversSeeded: true });
			return;
		}
		try {
			mergeCoverThumbs(await library.listCoverThumbnails(), generation);
		} catch (error) {
			console.error("Failed to seed cover thumbnails:", error);
		} finally {
			// Even a failed seed unblocks anything waiting on it (the first-run
			// flow's cover stage); the grid just falls back to placeholders.
			if (canCommitActive(generation)) set({ coversSeeded: true });
		}
		try {
			mergeCoverThumbs(await library.warmCoverThumbnails(), generation);
		} catch (error) {
			console.error("Failed to warm cover thumbnails:", error);
		}
	};

	const fetchBookPage = (
		library: Library,
		filter: BookGridFilter,
		key: string,
		generation: number,
		pageIndex: number,
	): Promise<void> => {
		const flightKey = `${generation}:${pageIndex}:${key}`;
		const existing = inFlightBookPages.get(flightKey);
		if (existing) return existing;

		const flight = (async () => {
			try {
				const page = await library.queryBooks(toBookQuery(filter, pageIndex));
				if (!canCommitActive(generation)) return;
				// A series reads in series order; the backend only sorts by
				// title/author, so the (single, unbounded) series page is
				// sorted by series_index here.
				const items =
					filter.seriesId !== null
						? [...page.items].sort(compareBySeriesIndex)
						: page.items;
				set((state) => {
					const nextCache = applyBookPage(state.bookCache, {
						key,
						generation,
						pageIndex,
						items,
						total: page.total,
					});
					return {
						bookCache: nextCache,
						staleBookSnapshot: advanceSnapshot(
							nextCache,
							state.staleBookSnapshot,
						),
						bookPagesError: null,
					};
				});
				ensureCoverThumbs(items);
			} catch (error) {
				if (!canCommitActive(generation)) return;
				set({
					bookPagesError:
						error instanceof Error ? error.message : "Failed to load books",
				});
			} finally {
				inFlightBookPages.delete(flightKey);
			}
		})();
		inFlightBookPages.set(flightKey, flight);
		return flight;
	};

	const refreshLibraryTotal = async (): Promise<void> => {
		const { library } = get();
		if (!library) return;
		const generation = get().bookCache.generation;
		try {
			// limit 0: count-only query (items stay empty, total ignores paging).
			const page = await library.queryBooks({
				...toBookQuery(ALL_BOOKS_FILTER, 0),
				limit: 0,
			});
			if (!canCommitActive(generation)) return;
			set({ libraryTotal: page.total });
		} catch (error) {
			console.error("Failed to load library total:", error);
		}
	};

	return {
		...initialState,

		// Stable actions object - ALL actions go here, created once and never change
		actions: {
			loadAuthors: async () => {
				const { library } = get();
				if (!library) return;
				if (isBackendDiverted()) return;
				const generation = get().bookCache.generation;

				set({ authorsLoading: true, authorsError: null });
				try {
					const authors = await library.listAuthors();
					if (!canCommitActive(generation)) return;
					set({ authors: authors.sort(sortAuthors), authorsLoading: false });
				} catch (error) {
					if (!canCommitActive(generation)) return;
					set({
						authorsError:
							error instanceof Error ? error.message : "Failed to load authors",
						authorsLoading: false,
					});
				}
			},

			loadSeries: async () => {
				const { library } = get();
				if (!library) return;
				if (isBackendDiverted()) return;
				const generation = get().bookCache.generation;

				set({ seriesLoading: true, seriesError: null });
				try {
					const series = await library.listSeries();
					if (!canCommitActive(generation)) return;
					set({ series, seriesLoading: false });
				} catch (error) {
					if (!canCommitActive(generation)) return;
					set({
						seriesError:
							error instanceof Error ? error.message : "Failed to load series",
						seriesLoading: false,
					});
				}
			},

			setBookFilter: (filter: BookGridFilter) => {
				const key = serializeBookFilter(filter);
				const cache = cacheForKey(get().bookCache, key);
				set({ bookFilter: filter, bookCache: cache });
			},

			ensureBookRange: async (start: number, end: number) => {
				// No new fetches for the outgoing generation while a shadow
				// switch is loading: the backend global may already point at
				// the target library, and the old content is about to be
				// replaced wholesale.
				if (isBackendDiverted()) return;
				const { library, bookFilter, bookCache } = get();
				if (!library) return;
				// Only serve the current key; a filter change mid-scroll means
				// the caller's range belongs to a retired cache.
				if (bookCache.key !== serializeBookFilter(bookFilter)) return;

				// A series is fetched whole as page 0 (see toBookQuery).
				const wantedPages =
					bookFilter.seriesId !== null
						? [0]
						: pagesCoveringRange(start, end, BOOK_PAGE_SIZE, bookCache.total);
				const missing = wantedPages.filter(
					(pageIndex) => !bookCache.pages.has(pageIndex),
				);
				if (missing.length === 0) return;

				await Promise.all(
					missing.map((pageIndex) =>
						fetchBookPage(
							library,
							bookFilter,
							bookCache.key,
							bookCache.generation,
							pageIndex,
						),
					),
				);
			},

			invalidateBooks: () => {
				// Re-request thumbnails as pages refetch: unchanged covers answer
				// from the backend's mtime-keyed cache, replaced covers regenerate.
				// Existing map entries stay so covers don't flash placeholders.
				requestedThumbIds.clear();
				set((state) => ({
					bookCache: invalidateBookCache(state.bookCache),
				}));
				// Mutations can rename/create series, change the library size,
				// and change per-author book counts (which ride on the authors
				// payload); refresh all three in the background.
				void get().actions.loadSeries();
				void get().actions.loadAuthors();
				void refreshLibraryTotal();
				// No full re-sweep here: visible pages refetch lazily and the
				// prefetch padding covers normal scrolling. The open-time sweep
				// guarantee degrades only for a scrollbar yank in the seconds
				// right after an edit — not worth ~total/100 queries per
				// mutation.
			},

			initialize: async (libraryPath: string) => {
				const startState = get();
				const confirmedPath = startState.confirmedLibraryPath;
				const switchingFromReady =
					startState.libraryState === LibraryState.ready &&
					confirmedPath !== null;

				// Switching back to the confirmed library (rapid A→B→A) is a
				// cancel: drop the pending shadow — its loads resolve into the
				// void — and re-point the backend global at the confirmed
				// library, which a superseded shadow's open may have moved.
				if (switchingFromReady && libraryPath === confirmedPath) {
					if (pendingSwitch === null) return;
					pendingSwitch = null;
					restoreBackend(libraryPath);
					return;
				}

				// A shadow load for this exact path is already in flight (the
				// initializer effect can re-fire with an unchanged path): let
				// it finish rather than racing a duplicate.
				if (pendingSwitch?.path === libraryPath) return;

				// On a switch the old content stays fully rendered through the
				// whole load — no teardown, `libraryState` stays `ready`. Only
				// the boot path (no confirmed library yet) clears state up
				// front, exactly as initialize always did.
				requestedThumbIds.clear();
				if (!switchingFromReady) {
					set((state) => ({
						libraryState: LibraryState.initializing,
						libraryError: null,
						bookCache: emptyBookCache(
							state.bookCache.key,
							state.bookCache.generation + 1,
						),
						staleBookSnapshot: null,
						coverThumbs: new Map<LibraryBook["id"], CoverThumbnail>(),
						libraryTotal: null,
						coversSeeded: false,
					}));
				}

				const shadowToken = ++shadowTokenCounter;
				pendingSwitch = { token: shadowToken, path: libraryPath };

				const filterAtStart = get().bookFilter;
				const keyAtStart = serializeBookFilter(filterAtStart);

				try {
					const library = await openBackend(libraryPath);
					if (pendingSwitch?.token !== shadowToken) return;
					// Boot path mirrors the old flow: the client handle lands
					// before the metadata does (the first-run flow observes
					// CONNECTED at this point). On a switch the handle only
					// becomes visible at the flip.
					if (!switchingFromReady) set({ library });

					// Shadow facts load in parallel; each failure is isolated
					// exactly as loadAuthors/loadSeries/refreshLibraryTotal do
					// today — only an open failure fails the whole initialize.
					const [authors, series, totalCount, firstPage] = await Promise.all([
						settleWithMessage(library.listAuthors(), "Failed to load authors"),
						settleWithMessage(library.listSeries(), "Failed to load series"),
						settleWithMessage(
							library.queryBooks({
								...toBookQuery(ALL_BOOKS_FILTER, 0),
								limit: 0,
							}),
							"Failed to load library total",
						),
						settleWithMessage(
							library.queryBooks(toBookQuery(filterAtStart, 0)),
							"Failed to load books",
						),
					]);
					if (pendingSwitch?.token !== shadowToken) return;

					// FLIP — one zustand set(): a single React commit that swaps
					// the active generation, its data, and the confirmed library
					// together. No blank frame between the old and new library.
					// Scroll-adjacent view state (bookFilter key, library-view
					// store) is intentionally untouched, matching the old
					// initialize.
					const shadowPages = new Map<number, LibraryBook[]>();
					if (firstPage.value !== null) {
						const items =
							filterAtStart.seriesId !== null
								? [...firstPage.value.items].sort(compareBySeriesIndex)
								: firstPage.value.items;
						shadowPages.set(0, items);
					}
					const shadowCache: PagedBookCache = {
						key: keyAtStart,
						generation: get().bookCache.generation + 1,
						total: firstPage.value?.total ?? null,
						pages: shadowPages,
					};
					const cache = cacheForKey(shadowCache, get().bookCache.key);
					set({
						library,
						libraryState: LibraryState.ready,
						libraryError: null,
						confirmedLibraryPath: libraryPath,
						bookCache: cache,
						staleBookSnapshot: null,
						coverThumbs: new Map<LibraryBook["id"], CoverThumbnail>(),
						libraryTotal: totalCount.value?.total ?? null,
						coversSeeded: false,
						authors: authors.value ? authors.value.sort(sortAuthors) : [],
						authorsLoading: false,
						authorsError: authors.error,
						series: series.value ?? [],
						seriesLoading: false,
						seriesError: series.error,
						bookPagesError: firstPage.error,
					});
					pendingSwitch = null;

					// GC the old generation: in-flight page fetches stamped with
					// a superseded generation can never land, so drop their
					// de-dupe entries.
					for (const flightKey of inFlightBookPages.keys()) {
						if (!flightKey.startsWith(`${cache.generation}:`)) {
							inFlightBookPages.delete(flightKey);
						}
					}

					// Background warm (as before): thumbnails for any scroll
					// offset; book pages load lazily via ensureBookRange.
					void warmCoverThumbs();
				} catch (error) {
					if (pendingSwitch?.token !== shadowToken) return;
					pendingSwitch = null;
					console.error("Failed to initialize library:", error);
					const normalizedError =
						error instanceof Error ? error : new Error(String(error));
					if (!switchingFromReady) {
						set({
							libraryState: LibraryState.error,
							libraryError: normalizedError,
						});
						return;
					}
					// A failed switch keeps the old content on screen (no
					// teardown, state stays ready); the shell surfaces the toast.
					// Always restore: `init_client` swaps the backend global
					// before granting the asset scope, so even a rejected open
					// can leave the backend pointing at the target.
					restoreBackend(confirmedPath);
					set({
						libraryError: normalizedError,
						authorsLoading: false,
						seriesLoading: false,
					});
				}
			},

			reset: () => {
				pendingSwitch = null;
				pendingRestore = null;
				requestedThumbIds.clear();
				set((state) => ({
					...initialState,
					// Keep the generation monotonic so fetches started before the
					// reset cannot land in the fresh cache.
					bookCache: emptyBookCache(
						initialState.bookCache.key,
						state.bookCache.generation + 1,
					),
					actions: state.actions,
				}));
			},

			createLibrary: async (libraryRoot: string) => {
				const create = await commands.clbCmdCreateLibrary(libraryRoot);
				if (create.status === "error") {
					console.error("Failed to create library", create.error);
					return;
				}
			},

			listValidFileTypes: async () => {
				const { library } = get();
				if (!library) return [];
				const types = await library.listValidFileTypes();
				return types.map((type) => type.extension);
			},

			getImportableBookMetadata: async (filePath: string) => {
				const { library } = get();
				if (!library) return;

				const importableFile = await library.checkFileImportable(filePath);
				if (!importableFile) {
					console.error(`File ${filePath} not importable`);
					return;
				}
				const metadata =
					await library.getImportableFileMetadata(importableFile);
				if (!metadata) {
					console.error(`Failed to get metadata for file at ${filePath}`);
					return;
				}

				return metadata;
			},

			commitAddBook: async (metadata: ImportableBookMetadata) => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) return;

				const bookId = await library.addImportableFileByMetadata(metadata);
				return bookId;
			},
			updateBook: async (
				bookId: string,
				updates: BookUpdate,
			): Promise<void> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.updateBook(bookId, updates);
				get().actions.invalidateBooks();
			},

			updateAuthor: async (
				authorId: string,
				updates: AuthorUpdate,
			): Promise<void> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.updateAuthor(authorId, updates);
				await get().actions.loadAuthors();
				// Cached pages render the old author name (and sort position).
				get().actions.invalidateBooks();
			},

			createAuthors: async (newAuthors: NewAuthor[]): Promise<void> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.createAuthors(newAuthors);
				await get().actions.loadAuthors();
			},

			deleteAuthor: async (authorId: string): Promise<void> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.deleteAuthor(authorId);
				await get().actions.loadAuthors();
			},

			deleteBookIdentifier: async (
				bookId: string,
				identifierId: number,
			): Promise<void> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.deleteBookIdentifier(bookId, identifierId);
				get().actions.invalidateBooks();
			},

			upsertBookIdentifier: async (
				bookId: string,
				identifierId: number | null,
				label: string,
				value: string,
			): Promise<void> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.upsertBookIdentifier(bookId, identifierId, label, value);
				get().actions.invalidateBooks();
			},

			addBook: async (
				metadata: ImportableBookMetadata,
			): Promise<string | undefined> => {
				if (isBackendDiverted()) throw new Error(SWITCH_IN_PROGRESS_ERROR);
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				const bookId = await library.addImportableFileByMetadata(metadata);
				if (bookId) {
					get().actions.invalidateBooks();
				}
				return bookId;
			},
		},
	};
});

// Selectors for library state
export const useLibraryState = () =>
	useLibraryStore((state) => state.libraryState);
export const useLibraryReady = () =>
	useLibraryStore((state) => state.libraryState === LibraryState.ready);
export const useConfirmedLibraryPath = () =>
	useLibraryStore((state) => state.confirmedLibraryPath);
export const useLibraryInitializing = () =>
	useLibraryStore((state) => state.libraryState === LibraryState.initializing);
export const useLibraryError = () =>
	useLibraryStore((state) => state.libraryError);

// Selectors for the paged book grid
export const useBookCache = () => useLibraryStore((state) => state.bookCache);
export const useBookPagesError = () =>
	useLibraryStore((state) => state.bookPagesError);
export const useStaleBookSnapshot = () =>
	useLibraryStore((state) => state.staleBookSnapshot);
export const useCoverThumb = (bookId: LibraryBook["id"]) =>
	useLibraryStore((state) => state.coverThumbs.get(bookId));
export const useCoverThumbsMap = () =>
	useLibraryStore((state) => state.coverThumbs);
export const useLibraryTotal = () =>
	useLibraryStore((state) => state.libraryTotal);

// Selectors for authors
export const useAuthors = () => useLibraryStore((state) => state.authors);
export const useAuthorsLoading = () =>
	useLibraryStore((state) => state.authorsLoading);
export const useAuthorsError = () =>
	useLibraryStore((state) => state.authorsError);

// Selectors for series
export const useSeriesList = () => useLibraryStore((state) => state.series);
export const useSeriesLoading = () =>
	useLibraryStore((state) => state.seriesLoading);

// Selector for stable actions object
export const useLibraryActions = () =>
	useLibraryStore((state) => state.actions);
