import { useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AlertDialog,
	Button,
	Checkbox,
	ContextMenu,
	SearchField,
	Select,
	Sheet,
	TextInput,
	Tooltip,
} from "@/components/ui";
import { bookGridView } from "@/lib/book-grid-view";
import {
	BOOK_PAGE_SIZE,
	type BookGridFilter,
	serializeBookFilter,
	shownBookItems,
} from "@/lib/book-page-cache";
import { useBookGridInteraction } from "@/lib/hooks/use-book-grid-interaction";
import {
	useBookDetails,
	useBookSelection,
	useBookSelectionSync,
} from "@/lib/hooks/use-book-selection";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useDeleteBooksDialog } from "@/lib/hooks/use-delete-books-dialog";
import { useEntryScroll } from "@/lib/hooks/use-entry-scroll";
import { useLibraryKeymap } from "@/lib/hooks/use-library-keymap";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { useOnLibraryFlip } from "@/lib/hooks/use-on-library-flip";
import { useSearchScopeMenu } from "@/lib/hooks/use-search-scope-menu";
import { useShownEntryKey } from "@/lib/hooks/use-shown-entry-key";
import { SORT_LABELS } from "@/lib/library-sort-options";
import { SCROLL_REGION, scrollRegionAttributes } from "@/lib/navigation";
import type { ShelfViewFields } from "@/lib/platform/settings/types";
import { noMatchesText, searchPlaceholder } from "@/lib/search-scope";
import {
	type BookRouteFilters,
	deepLinkClearsQuery,
	shelfFilterFromView,
	shelfViewSummary,
} from "@/lib/shelves";
import { closeBookDetails } from "@/stores/book-selection/store";
import {
	useAuthors,
	useBookCache,
	useLibraryActions,
	useLibraryReady,
	useLibraryTotal,
	usePageOutcome,
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
import {
	setShelfSheetOpen,
	useMenuRequests,
} from "@/stores/menu-requests/store";
import { createSmartShelf } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";
import { F7Bookmark } from "../icons/F7Bookmark";
import { BookGrid, type BookGridHandle } from "../molecules/BookGrid";
import { EmptyLibrary, EmptyState } from "../molecules/EmptyState";
import { BookDetailsDrawer } from "../organisms/BookDrawer";
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
	const searchScope = useLibraryView((s) => s.searchScope);
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
	const pageOutcome = usePageOutcome();
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
			searchScope,
			sortOrder,
		}),
		[
			debouncedQuery,
			author_id,
			series_id,
			tag_id,
			publisher_id,
			hideRead,
			searchScope,
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
	const books = useMemo(
		() => shownBookItems(cache, staleSnapshot),
		[cache, staleSnapshot],
	);

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

	const details = useBookDetails(books);

	// Coming Back to this entry finds the selection and details as left.
	const entryKey = useShownEntryKey("/");
	useBookSelectionSync({
		books,
		resetKey: cache.key,
		viewKey: serializeBookFilter(filter),
		entryKey,
	});
	const { selectedCount, isSelected } = useBookSelection();
	// The rules of the grid status and the empty states are in bookGridView.
	const gridView = bookGridView({
		libraryReady,
		cache,
		staleSnapshot,
		pageOutcome,
		libraryTotal,
		selectedCount,
	});
	const grid = useBookGridInteraction(books);

	const searchInputRef = useRef<HTMLInputElement>(null);
	const gridContainerRef = useRef<HTMLDivElement>(null);
	// Filled in by the virtualized BookGrid; lets keyboard selection scroll
	// rows into view even when their cards are not mounted.
	const gridHandleRef = useRef<BookGridHandle | null>(null);

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

	// Edit > Find (⌘F): focus the search, once the page shows.
	const findPending = useMenuRequests((s) => s.findPending);
	useEffect(() => {
		if (!findPending) return;
		useMenuRequests.setState({ findPending: false });
		closeBookDetails();
		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	}, [findPending]);

	useLibraryKeymap({
		books,
		drawerOpened: details.open,
		searchInputRef,
		gridContainerRef,
		gridRef: gridHandleRef,
		onClearSearch: () => setQuery(""),
	});

	// A genuinely empty library (including first-run with the bundled library)
	// teaches the two ways to populate it; an empty result against a non-empty
	// library is a zero-result filter.
	const showGrid = !gridView.emptyLibrary && !gridView.noMatches;
	const regionProps = {
		ref: gridContainerRef,
		...scrollRegionAttributes(SCROLL_REGION.libraryGrid),
		style: { outline: "none" },
		className: clsx(
			styles.gridArea,
			"ctd-scroller",
			// Dimming hint shown over the stale grid while the new query
			// fetches. No dimming while the last answer for the filter is an
			// error.
			gridView.status === "searching" && styles.gridAreaSearching,
		),
	};
	const trimmedQuery = query.trim();

	const { menu: scopeMenu, button: scopeButton } =
		useSearchScopeMenu(searchInputRef);

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
			 * Finder-style scope bar above the grid's scroll region. It is a
			 * size container: the sidebar and window both change the panel's
			 * width, so its controls reflow on the bar's own width.
			 */}
			<div className={styles.scopeBar}>
				<div className={styles.scopeControls}>
					<span className={styles.searchWrap}>
						<SearchField
							ref={searchInputRef}
							placeholder={
								searchTokens.length > 0
									? undefined
									: searchPlaceholder(searchScope)
							}
							aria-label="Search books"
							message={gridView.callout ?? undefined}
							scopeButton={scopeButton}
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
						view={{ query, sortOrder, hideRead, searchScope }}
						routeFilters={{ author_id, series_id, tag_id, publisher_id }}
					/>
				</div>
			</div>
			{showGrid ? (
				// The scroll region is the listbox VoiceOver reads: it keeps focus
				// while arrows move the cursor (aria-activedescendant), since the
				// virtualized cards come and go. Its keys live in use-library-keymap.
				<div
					{...regionProps}
					role="listbox"
					aria-label="Books"
					aria-multiselectable
					aria-activedescendant={grid.activeDescendant}
					tabIndex={0}
					onClick={grid.onBackgroundClick}
					onKeyDown={grid.onGridKeyDown}
				>
					<BookGrid
						bookList={books}
						loading={gridView.status === "loading"}
						pendingSlots={gridView.status === "stale" ? "hidden" : "loading"}
						bookActions={grid.bookActions}
						isSelected={isSelected}
						scrollElementRef={gridContainerRef}
						initialScrollOffset={gridStartOffset}
						resultKey={`${cache.key}:${queryResolved}`}
						handleRef={gridHandleRef}
						onVisibleRangeChange={onVisibleRangeChange}
					/>
				</div>
			) : (
				<div {...regionProps} tabIndex={-1}>
					{gridView.emptyLibrary ? (
						<EmptyLibrary />
					) : trimmedQuery.length > 0 ? (
						<EmptyState
							art="search"
							title={`No books match “${trimmedQuery}”`}
							description={noMatchesText(searchScope)}
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
					)}
				</div>
			)}
			<div className={styles.footer}>
				<span className={styles.footerText} aria-live="polite">
					{gridView.footer}
				</span>
			</div>
			<BookDetailsDrawer
				book={details.book}
				open={details.open}
				onClose={closeBookDetails}
				returnFocusRef={gridContainerRef}
				className={styles.drawer}
			/>
			<ContextMenu
				menu={grid.menu.menu}
				returnFocusRef={gridContainerRef}
				onClose={grid.menu.close}
			/>
			<ContextMenu
				menu={scopeMenu.menu}
				returnFocusRef={scopeMenu.returnFocusRef}
				onClose={scopeMenu.close}
			/>
			<DeleteBooksDialogs />
		</div>
	);
};

/** "Delete 2 books?" and, when files stayed behind, what to do about them. */
const DeleteBooksDialogs = () => {
	const dialog = useDeleteBooksDialog();
	return (
		<>
			<AlertDialog
				open={dialog.confirmOpen}
				onOpenChange={(open) => {
					if (!open) dialog.cancel();
				}}
				title={dialog.title}
				textAlign="left"
				description={dialog.copy.description}
				confirmLabel={dialog.copy.confirmLabel}
				destructive
				onConfirm={dialog.confirm}
			/>
			<AlertDialog
				open={dialog.problemOpen}
				onOpenChange={(open) => {
					if (!open) dialog.dismissProblem();
				}}
				title={dialog.problemTitle}
				textAlign="left"
				description={dialog.problemDescription}
				confirmLabel="OK"
				onConfirm={dialog.dismissProblem}
			/>
		</>
	);
};

interface SaveAsShelfControlProps {
	view: ShelfViewFields;
	routeFilters: BookRouteFilters;
}

const SaveAsShelfControl = ({
	view,
	routeFilters,
}: SaveAsShelfControlProps) => {
	const applyShelf = useLibraryView((s) => s.applyShelf);
	const libraryId = useLibrarySelection().activeLibrary?.id;
	const bookmarkButtonRef = useRef<HTMLButtonElement>(null);

	// Library > New Shelf… opens the same sheet from the menu bar.
	const isOpen = useMenuRequests((s) => s.shelfSheetOpen);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);

	// The sheet is the page's: leaving the page closes it.
	useEffect(() => () => setShelfSheetOpen(false), []);

	const close = () => {
		setShelfSheetOpen(false);
		setName("");
		setError(null);
	};

	const summary = shelfViewSummary(view, routeFilters);

	const save = async () => {
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			return;
		}

		try {
			const shelf = await createSmartShelf(
				trimmed,
				shelfFilterFromView(view, routeFilters, libraryId),
			);
			applyShelf(shelf);
			close();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<>
			<Tooltip label="Keep these filters as a shelf in the sidebar">
				<Button
					ref={bookmarkButtonRef}
					variant="subtle"
					className={styles.shelfButton}
					onClick={() => setShelfSheetOpen(true)}
				>
					<F7Bookmark
						aria-hidden="true"
						style={{ fontSize: "var(--ctd-text-body)" }}
					/>
					<span className={styles.shelfLabel}>Save as shelf…</span>
				</Button>
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
	sortOrder: LibraryBookSortOrderKey;
	searchQuery: string;
}
