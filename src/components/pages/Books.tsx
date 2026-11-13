import { useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryBook } from "@/bindings";
import {
	Button,
	Checkbox,
	Drawer,
	IconButton,
	SearchField,
	Select,
	Sheet,
	TextInput,
	Tooltip,
} from "@/components/ui";
import {
	BOOK_PAGE_SIZE,
	type BookGridFilter,
	serializeBookFilter,
	sparseBookItems,
} from "@/lib/book-page-cache";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useEntryScroll } from "@/lib/hooks/use-entry-scroll";
import { useLibraryKeymap } from "@/lib/hooks/use-library-keymap";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { useOnLibraryFlip } from "@/lib/hooks/use-on-library-flip";
import { SCROLL_REGION, scrollRegionAttributes } from "@/lib/navigation";
import {
	type BookRouteFilters,
	deepLinkClearsQuery,
	hasRouteFilters,
	routeFiltersToShelf,
} from "@/lib/shelves";
import {
	useAuthors,
	useBookCache,
	useLibraryActions,
	useLibraryReady,
	useLibraryTotal,
	usePublishers,
	useSeriesList,
	useStaleBookSnapshot,
	useTags,
} from "@/stores/library/store";
import {
	LibraryBookSortOrder,
	type LibraryBookSortOrderKey,
	useLibraryView,
} from "@/stores/library-view/store";
import { createSmartShelf } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";
import { F7Bookmark } from "../icons/F7Bookmark";
import { BookGrid, type ScrollToBookIndex } from "../molecules/BookGrid";
import { EmptyLibrary, EmptyState } from "../molecules/EmptyState";
import { BookDrawer } from "../organisms/BookDrawer";
import styles from "./Books.module.css";

interface BookSearchOptions {
	/** Deep-link: only books by this author (LibraryAuthor id). */
	author_id?: string;
	/** Deep-link: only books in this series (LibrarySeries id). */
	series_id?: number;
	/** Deep-link: only books with this tag (LibraryTag id). */
	tag_id?: number;
	/** Deep-link: only books from this publisher (LibraryPublisher id). */
	publisher_id?: number;
}

const SORT_LABELS: Record<LibraryBookSortOrderKey, string> = {
	nameAz: "Name (A–Z)",
	nameZa: "Name (Z–A)",
	authorAz: "Author (A–Z)",
	authorZa: "Author (Z–A)",
};

/**
 * How long the search text must sit still before it becomes a new paged
 * cache key (each distinct key costs backend fetches). The field itself
 * stays instant; only the query is debounced.
 */
const QUERY_DEBOUNCE_MS = 200;

export const Books = ({
	author_id,
	series_id,
	tag_id,
	publisher_id,
}: BookSearchOptions) => {
	const query = useLibraryView((s) => s.query);
	const sortOrder = useLibraryView((s) => s.sortOrder);
	const hideRead = useLibraryView((s) => s.hideRead);
	const setQuery = useLibraryView((s) => s.setQuery);
	const setSortOrder = useLibraryView((s) => s.setSortOrder);
	const setHideRead = useLibraryView((s) => s.setHideRead);
	const resetToAllBooks = useLibraryView((s) => s.resetToAllBooks);

	// An author, series, tag or publisher link promises "those books in one
	// click", so a text query from before the click must not keep filtering
	// the results.
	// The exception is arriving through a shelf saved from that very view: its
	// query is part of the shelf and must survive.
	useEffect(() => {
		const route = { author_id, series_id, tag_id, publisher_id };
		const { activeShelfId } = useLibraryView.getState();
		const shelf = useSettings
			.getState()
			.smartShelves.find((candidate) => candidate.id === activeShelfId);
		if (deepLinkClearsQuery(route, shelf?.filter)) setQuery("");
	}, [author_id, series_id, tag_id, publisher_id, setQuery]);

	const actions = useLibraryActions();
	const libraryReady = useLibraryReady();
	const cache = useBookCache();
	const staleSnapshot = useStaleBookSnapshot();
	const libraryTotal = useLibraryTotal();
	const authors = useAuthors();
	const seriesList = useSeriesList();
	const tags = useTags();
	const publishers = usePublishers();

	const debouncedQuery = useDebouncedValue(query, QUERY_DEBOUNCE_MS);
	const filter = useMemo<BookGridFilter>(
		() => ({
			text: debouncedQuery,
			authorId: author_id ?? null,
			seriesId: series_id ?? null,
			tagId: tag_id ?? null,
			publisherId: publisher_id ?? null,
			hideRead,
			sortOrder,
		}),
		[
			debouncedQuery,
			author_id,
			series_id,
			tag_id,
			publisher_id,
			hideRead,
			sortOrder,
		],
	);

	useEffect(() => {
		if (!libraryReady) return;
		actions.setBookFilter(filter);
	}, [libraryReady, filter, actions]);

	// Fetch one page beyond each edge of the rendered window so fast scrolling
	// lands on loaded rows instead of placeholder covers. pagesCoveringRange
	// clamps to the real bounds, so over-asking at the edges is free.
	const ensureRangePadded = useCallback(
		(start: number, end: number) => {
			void actions.ensureBookRange(
				start - BOOK_PAGE_SIZE,
				end + BOOK_PAGE_SIZE,
			);
		},
		[actions],
	);

	// The grid's last reported viewport; pages covering it are (re)fetched
	// whenever the cache key or generation moves (filter change, mutation).
	const lastRangeRef = useRef({ start: 0, end: 0 });
	// biome-ignore lint/correctness/useExhaustiveDependencies: cache.key/cache.generation are triggers — a new filter or an invalidation must refetch the pages behind the current viewport.
	useEffect(() => {
		if (!libraryReady) return;
		const { start, end } = lastRangeRef.current;
		ensureRangePadded(start, end);
	}, [libraryReady, cache.key, cache.generation, ensureRangePadded]);

	const onVisibleRangeChange = useCallback(
		(start: number, end: number) => {
			lastRangeRef.current = { start, end };
			ensureRangePadded(start, end);
		},
		[ensureRangePadded],
	);

	// Stale-while-revalidate: while the new query's first page is in flight
	// (cache.total === null), show the previous snapshot so the grid never
	// blanks. Once the new query resolves, live cache takes over.
	const queryResolved = cache.total !== null;
	const activeBooks = useMemo(() => sparseBookItems(cache), [cache]);
	const books = queryResolved
		? activeBooks
		: (staleSnapshot?.items ?? activeBooks);
	const total = queryResolved ? cache.total : (staleSnapshot?.total ?? 0);

	// True loading = no resolved data at all (fresh library open, no stale
	// snapshot to show). During a search transition we are "searching", not
	// "loading" — the stale grid stays visible.
	const loading = !libraryReady || (!queryResolved && staleSnapshot === null);
	// Dimming hint shown over the stale grid while the new query fetches.
	const isSearching = libraryReady && !queryResolved && staleSnapshot !== null;

	const navigate = useNavigate();
	const onClearDeepLinkFilter = useCallback(() => {
		void navigate({ to: "/", search: {} });
	}, [navigate]);

	const authorTokenName =
		author_id !== undefined
			? (authors.find((author) => author.id === author_id)?.name ?? "Author")
			: undefined;
	const seriesTokenName =
		series_id !== undefined
			? (seriesList.find((series) => series.id === series_id)?.name ?? "Series")
			: undefined;
	const tagTokenName =
		tag_id !== undefined
			? (tags?.find((tag) => tag.id === tag_id)?.name ?? "Tag")
			: undefined;
	const publisherTokenName =
		publisher_id !== undefined
			? (publishers?.find((publisher) => publisher.id === publisher_id)?.name ??
				"Publisher")
			: undefined;

	// Tag and publisher lists load lazily; a deep link straight into a
	// filtered view still needs the name for its token.
	useEffect(() => {
		if (!libraryReady) return;
		if (tag_id !== undefined && tags === null) {
			void actions.loadTags();
		}
		if (publisher_id !== undefined && publishers === null) {
			void actions.loadPublishers();
		}
	}, [libraryReady, tag_id, publisher_id, tags, publishers, actions]);

	const [isBookSidebarOpen, setIsBookSidebarOpen] = useState(false);

	const [selectedSidebarBook, setSelectedSidebarBook] =
		useState<LibraryBook | null>(null);
	const onBookOpen = useCallback(
		(bookId: LibraryBook["id"]) => {
			const book = books.find(
				(candidate) => candidate !== undefined && candidate.id === bookId,
			);
			if (!book) return;
			setSelectedSidebarBook(book);
			setIsBookSidebarOpen(true);
		},
		[books],
	);

	const searchInputRef = useRef<HTMLInputElement>(null);
	const gridContainerRef = useRef<HTMLDivElement>(null);
	// Filled in by the virtualized BookGrid; lets keyboard selection scroll
	// rows into view even when their cards are not mounted.
	const scrollToBookIndexRef = useRef<ScrollToBookIndex | null>(null);

	// Back returns the grid to where it was left; a new search, filter or
	// sort starts at the top. Generation bumps from same-key invalidations
	// (a mutation) share the key, so they keep the scroll.
	const { startOffset: gridStartOffset } = useEntryScroll({
		region: SCROLL_REGION.libraryGrid,
		elementRef: gridContainerRef,
		viewKey: cache.key,
		viewReady: queryResolved && cache.key === serializeBookFilter(filter),
		content: books,
	});

	// Reset scroll to top on a library flip: the flip swaps in a new
	// generation under the SAME filter key, so the reset above never fires
	// and the old offset would show placeholders below the incoming page 0.
	// The flip hook's layout effect lands before the generation-triggered
	// refetch above reads lastRangeRef (refetch the top viewport, not the
	// stale one).
	useOnLibraryFlip(
		useCallback(() => {
			if (gridContainerRef.current) {
				gridContainerRef.current.scrollTop = 0;
			}
			lastRangeRef.current = { start: 0, end: 0 };
		}, []),
	);

	const { selectedBookId } = useLibraryKeymap({
		books,
		resetToken: cache.key,
		drawerOpened: isBookSidebarOpen,
		searchInputRef,
		gridContainerRef,
		scrollToBookIndexRef,
		onBookOpen,
		onClearSearch: () => setQuery(""),
	});

	// A genuinely empty library (including first-run with the bundled library)
	// teaches the two ways to populate it; an empty result against a non-empty
	// library is a zero-result filter.
	const emptyLibrary = !loading && (libraryTotal ?? 0) === 0;
	// Only show the zero-result state once the active query has resolved to 0
	// results — never transiently while a new search is still in flight.
	const noMatches =
		!loading && queryResolved && total === 0 && (libraryTotal ?? 0) > 0;
	const trimmedQuery = query.trim();

	const searchTokens = [
		...(authorTokenName !== undefined
			? [
					{
						label: `Author: ${authorTokenName}`,
						onRemove: onClearDeepLinkFilter,
						title: "Showing only books by this author",
					},
				]
			: []),
		...(seriesTokenName !== undefined
			? [
					{
						label: `Series: ${seriesTokenName}`,
						onRemove: onClearDeepLinkFilter,
						title:
							"Books are sorted in series order while this filter is active",
					},
				]
			: []),
		...(tagTokenName !== undefined
			? [
					{
						label: `Tag: ${tagTokenName}`,
						onRemove: onClearDeepLinkFilter,
						title: "Showing only books with this tag",
					},
				]
			: []),
		...(publisherTokenName !== undefined
			? [
					{
						label: `Publisher: ${publisherTokenName}`,
						onRemove: onClearDeepLinkFilter,
						title: "Showing only books from this publisher",
					},
				]
			: []),
	];

	return (
		<div className={styles.page}>
			{/*
			 * Finder-style scope bar: pinned to the top of the scroll container
			 * (the panel div wrapping <Outlet/> in __root), above the content.
			 */}
			<div className={styles.scopeBar}>
				<span className={styles.searchWrap}>
					<SearchField
						ref={searchInputRef}
						placeholder={searchTokens.length > 0 ? undefined : "Search"}
						aria-label="Search book titles and authors"
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						className={styles.searchInput}
						tokens={searchTokens.length > 0 ? searchTokens : undefined}
					/>
				</span>
				<Select
					width={150}
					aria-label="Sort order"
					options={(
						Object.keys(LibraryBookSortOrder) as LibraryBookSortOrderKey[]
					).map((key) => ({
						value: key,
						label: SORT_LABELS[key],
					}))}
					value={sortOrder}
					onChange={(value) => setSortOrder(value as LibraryBookSortOrderKey)}
					disabled={series_id !== undefined}
				/>
				<span className={styles.unreadToggle}>
					<Checkbox
						label="Unread only"
						checked={hideRead}
						onCheckedChange={setHideRead}
					/>
				</span>
				<SaveAsShelfControl
					query={query}
					sortOrder={sortOrder}
					hideRead={hideRead}
					routeFilters={{ author_id, series_id, tag_id, publisher_id }}
				/>
			</div>
			<div
				ref={gridContainerRef}
				{...scrollRegionAttributes(SCROLL_REGION.libraryGrid)}
				tabIndex={-1}
				style={{ outline: "none" }}
				className={clsx(
					styles.gridArea,
					isSearching && styles.gridAreaSearching,
				)}
			>
				{emptyLibrary ? (
					<EmptyLibrary />
				) : noMatches ? (
					trimmedQuery.length > 0 ? (
						<EmptyState
							art="search"
							title={`No books match “${trimmedQuery}”`}
							description="Search looks at titles and authors. Check the spelling, or try fewer words."
						>
							<Button variant="default" onClick={() => setQuery("")}>
								Clear Search
							</Button>
						</EmptyState>
					) : (
						<EmptyState
							title="No books match these filters"
							description="Every book here is filtered out. Show all books to see the whole library."
						>
							<Button
								variant="default"
								onClick={() => {
									resetToAllBooks();
									onClearDeepLinkFilter();
								}}
							>
								Show all books
							</Button>
						</EmptyState>
					)
				) : (
					<BookGrid
						bookList={books}
						loading={loading}
						onBookOpen={onBookOpen}
						selectedBookId={selectedBookId}
						scrollElementRef={gridContainerRef}
						initialScrollOffset={gridStartOffset}
						resultKey={`${cache.key}:${queryResolved}`}
						scrollToBookIndexRef={scrollToBookIndexRef}
						onVisibleRangeChange={onVisibleRangeChange}
					/>
				)}
			</div>
			<div className={styles.footer}>
				<span className={styles.footerText}>
					{loading
						? "Loading books…"
						: libraryTotal === null || total === libraryTotal
							? `${total} books`
							: `${total} of ${libraryTotal} books`}
				</span>
			</div>
			<Drawer
				open={isBookSidebarOpen}
				onOpenChange={(open) => {
					if (!open) setIsBookSidebarOpen(false);
				}}
				width={500}
				bleed
				onCloseAutoFocus={(event) => {
					// No Dialog.Trigger to return focus to; hand it to the grid so
					// arrow keys keep working after the drawer closes.
					event.preventDefault();
					gridContainerRef.current?.focus();
				}}
				onOpenAutoFocus={(event) => {
					// Land on the primary action instead of the header close button.
					const target = document.querySelector("[data-drawer-initial-focus]");
					if (target instanceof HTMLElement) {
						event.preventDefault();
						target.focus();
					}
				}}
			>
				{selectedSidebarBook && (
					<BookDrawer
						book={selectedSidebarBook}
						onClose={() => setIsBookSidebarOpen(false)}
					/>
				)}
			</Drawer>
		</div>
	);
};

interface SaveAsShelfControlProps {
	query: string;
	sortOrder: LibraryBookSortOrderKey;
	hideRead: boolean;
	routeFilters: BookRouteFilters;
}

const SaveAsShelfControl = ({
	query,
	sortOrder,
	hideRead,
	routeFilters,
}: SaveAsShelfControlProps) => {
	const applyShelf = useLibraryView((s) => s.applyShelf);
	const libraryId = useLibrarySelection().activeLibrary?.id;
	const bookmarkButtonRef = useRef<HTMLButtonElement>(null);

	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const close = () => {
		setIsOpen(false);
		setName("");
		setError(null);
	};

	const summary = [
		...(hasRouteFilters(routeFilters) ? ["this view's filter"] : []),
		query.trim().length > 0 ? `search "${query.trim()}"` : "no search",
		`sorted by ${SORT_LABELS[sortOrder]}`,
		hideRead ? "hiding read books" : "showing read books",
	].join(", ");

	const save = async () => {
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			return;
		}

		try {
			const shelf = await createSmartShelf(trimmed, {
				query,
				sortOrder,
				hideRead,
				...routeFiltersToShelf(routeFilters, libraryId),
			});
			applyShelf(shelf);
			close();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<>
			<Tooltip label="Save as shelf…">
				<IconButton
					ref={bookmarkButtonRef}
					className={styles.shelfButton}
					aria-label="Save as shelf"
					onClick={() => setIsOpen(true)}
				>
					<F7Bookmark style={{ fontSize: 15 }} />
				</IconButton>
			</Tooltip>
			<Sheet
				open={isOpen}
				onOpenChange={(open) => {
					if (!open) close();
				}}
				title="Save as shelf"
				width={420}
				onCloseAutoFocus={(event) => {
					// The sheet has no Dialog.Trigger; return focus to the bookmark
					// button ourselves.
					event.preventDefault();
					bookmarkButtonRef.current?.focus();
				}}
			>
				<div className={styles.shelfForm}>
					<TextInput
						placeholder="Shelf name"
						aria-label="Shelf name"
						// biome-ignore lint/a11y/noAutofocus: the sheet exists to name the shelf; focus must land in the field.
						autoFocus
						value={name}
						error={error}
						onChange={(event) => {
							setName(event.currentTarget.value);
							setError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								void save();
							}
						}}
					/>
					<span className={styles.shelfFormHint}>
						Saves the current filters: {summary}.
					</span>
					<div className={styles.shelfFormActions}>
						<Button variant="default" onClick={close}>
							Cancel
						</Button>
						<Button
							variant="primary"
							onClick={() => void save()}
							disabled={name.trim().length === 0}
						>
							Save
						</Button>
					</div>
				</div>
			</Sheet>
		</>
	);
};

export interface BookViewOptions {
	sortOrder: "authorAz" | "authorZa" | "nameAz" | "nameZa";
	searchQuery: string;
}
