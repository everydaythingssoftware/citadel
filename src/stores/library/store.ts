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

export const useLibraryStore = create<LibraryStoreState>((set, get) => {
	const mergeCoverThumbs = (thumbs: CoverThumbnail[]): void => {
		if (thumbs.length === 0) return;
		set((state) => {
			const next = new Map(state.coverThumbs);
			for (const thumb of thumbs) next.set(thumb.book_id, thumb);
			return { coverThumbs: next };
		});
	};

	/**
	 * Fire-and-forget thumbnail fetch for freshly landed page items. Failures
	 * un-mark the ids so a later page fetch retries; the grid just keeps its
	 * fallback rendering in the meantime.
	 */
	const ensureCoverThumbs = (books: LibraryBook[]): void => {
		const { library } = get();
		if (!library) return;
		const wanted = books
			.filter(
				(book) => book.cover_image !== null && !requestedThumbIds.has(book.id),
			)
			.map((book) => book.id);
		if (wanted.length === 0) return;
		for (const id of wanted) requestedThumbIds.add(id);

		void library
			.ensureCoverThumbnails(wanted)
			.then(mergeCoverThumbs)
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
		if (!library) {
			set({ coversSeeded: true });
			return;
		}
		try {
			mergeCoverThumbs(await library.listCoverThumbnails());
		} catch (error) {
			console.error("Failed to seed cover thumbnails:", error);
		} finally {
			// Even a failed seed unblocks anything waiting on it (the first-run
			// flow's cover stage); the grid just falls back to placeholders.
			set({ coversSeeded: true });
		}
		try {
			mergeCoverThumbs(await library.warmCoverThumbnails());
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
		try {
			// limit 0: count-only query (items stay empty, total ignores paging).
			const page = await library.queryBooks({
				...toBookQuery(ALL_BOOKS_FILTER, 0),
				limit: 0,
			});
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

				set({ authorsLoading: true, authorsError: null });
				try {
					const authors = await library.listAuthors();
					set({ authors: authors.sort(sortAuthors), authorsLoading: false });
				} catch (error) {
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

				set({ seriesLoading: true, seriesError: null });
				try {
					const series = await library.listSeries();
					set({ series, seriesLoading: false });
				} catch (error) {
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
				const actions = get().actions;

				// Retire any cached data from a previously open library. The
				// paged cache keeps its key but moves to a new generation so
				// in-flight fetches against the old library cannot land.
				// Clear the stale snapshot and thumbnails too — they belong to the
				// old library.
				requestedThumbIds.clear();
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

				try {
					const library = await initClient(localLibraryFromPath(libraryPath));
					set({ library });

					// The grid pages books in on demand (ensureBookRange); only
					// the cheap whole-library facts load eagerly.
					await Promise.all([
						actions.loadAuthors(),
						actions.loadSeries(),
						refreshLibraryTotal(),
					]);

					set({ libraryState: LibraryState.ready });

					// Background warm: generate every cover's thumbnail so the grid
					// decodes small images at any scroll offset, not just visited
					// pages. Book pages themselves load lazily (viewport + one page
					// of padding); a long-distance jump into unvisited territory
					// shows placeholder cells for one ~60ms page query.
					void warmCoverThumbs();
				} catch (error) {
					console.error("Failed to initialize library:", error);
					set({
						libraryState: LibraryState.error,
						libraryError:
							error instanceof Error ? error : new Error(String(error)),
					});
				}
			},

			reset: () => {
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
				const { library } = get();
				if (!library) return;

				const bookId = await library.addImportableFileByMetadata(metadata);
				return bookId;
			},
			updateBook: async (
				bookId: string,
				updates: BookUpdate,
			): Promise<void> => {
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.updateBook(bookId, updates);
				get().actions.invalidateBooks();
			},

			updateAuthor: async (
				authorId: string,
				updates: AuthorUpdate,
			): Promise<void> => {
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.updateAuthor(authorId, updates);
				await get().actions.loadAuthors();
				// Cached pages render the old author name (and sort position).
				get().actions.invalidateBooks();
			},

			createAuthors: async (newAuthors: NewAuthor[]): Promise<void> => {
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.createAuthors(newAuthors);
				await get().actions.loadAuthors();
			},

			deleteAuthor: async (authorId: string): Promise<void> => {
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.deleteAuthor(authorId);
				await get().actions.loadAuthors();
			},

			deleteBookIdentifier: async (
				bookId: string,
				identifierId: number,
			): Promise<void> => {
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
				const { library } = get();
				if (!library) throw new Error("Library not initialized");
				await library.upsertBookIdentifier(bookId, identifierId, label, value);
				get().actions.invalidateBooks();
			},

			addBook: async (
				metadata: ImportableBookMetadata,
			): Promise<string | undefined> => {
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
