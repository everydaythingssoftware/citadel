import { Link, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import DOMPurify from "dompurify";
import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Identifier, LibraryBook, LocalFile } from "@/bindings";
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
import { safeAsyncEventHandler } from "@/lib/async";
import {
	BOOK_PAGE_SIZE,
	type BookGridFilter,
	sparseBookItems,
} from "@/lib/book-page-cache";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useLibraryKeymap } from "@/lib/hooks/use-library-keymap";
import { useOnLibraryFlip } from "@/lib/hooks/use-on-library-flip";
import { usePlatform } from "@/lib/platform/context";
import { formatSeriesIndex } from "@/lib/series";
import {
	useAuthors,
	useBookCache,
	useLibraryActions,
	useLibraryReady,
	useLibraryTotal,
	useSeriesList,
	useStaleBookSnapshot,
} from "@/stores/library/store";
import {
	LibraryBookSortOrder,
	type LibraryBookSortOrderKey,
	useLibraryView,
} from "@/stores/library-view/store";
import { createSmartShelf } from "@/stores/settings/actions";
import { BookCover } from "../atoms/BookCover";
import { F7Bookmark } from "../icons/F7Bookmark";
import { F7Pencil } from "../icons/F7Pencil";
import { TablerCopy } from "../icons/TablerCopy";
import { BookGrid, type ScrollToBookIndex } from "../molecules/BookGrid";
import { EmptyLibrary, EmptyState } from "../molecules/EmptyState";
import styles from "./Books.module.css";

interface BookSearchOptions {
	/** Deep-link: only books by this author (LibraryAuthor id). */
	author_id?: string;
	/** Deep-link: only books in this series (LibrarySeries id). */
	series_id?: number;
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

export const Books = ({ author_id, series_id }: BookSearchOptions) => {
	const query = useLibraryView((s) => s.query);
	const sortOrder = useLibraryView((s) => s.sortOrder);
	const hideRead = useLibraryView((s) => s.hideRead);
	const setQuery = useLibraryView((s) => s.setQuery);
	const setSortOrder = useLibraryView((s) => s.setSortOrder);
	const setHideRead = useLibraryView((s) => s.setHideRead);
	const resetToAllBooks = useLibraryView((s) => s.resetToAllBooks);

	// An author or series link promises "those books in one click", so a
	// text query from before the click must not keep filtering the results.
	useEffect(() => {
		if (author_id !== undefined || series_id !== undefined) {
			setQuery("");
		}
	}, [author_id, series_id, setQuery]);

	const actions = useLibraryActions();
	const libraryReady = useLibraryReady();
	const cache = useBookCache();
	const staleSnapshot = useStaleBookSnapshot();
	const libraryTotal = useLibraryTotal();
	const authors = useAuthors();
	const seriesList = useSeriesList();

	const debouncedQuery = useDebouncedValue(query, QUERY_DEBOUNCE_MS);
	const filter = useMemo<BookGridFilter>(
		() => ({
			text: debouncedQuery,
			authorId: author_id ?? null,
			seriesId: series_id ?? null,
			hideRead,
			sortOrder,
		}),
		[debouncedQuery, author_id, series_id, hideRead, sortOrder],
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

	// Reset scroll to top whenever the filter key changes (new search).
	// Generation bumps from same-key invalidations share the key, so they
	// correctly do NOT reset scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: cache.key is the only trigger; gridContainerRef is a stable ref whose .current we imperatively update.
	useEffect(() => {
		if (gridContainerRef.current) {
			gridContainerRef.current.scrollTop = 0;
		}
	}, [cache.key]);

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
				<Checkbox
					label="Unread only"
					checked={hideRead}
					onCheckedChange={setHideRead}
				/>
				<SaveAsShelfControl
					query={query}
					sortOrder={sortOrder}
					hideRead={hideRead}
				/>
			</div>
			<div
				ref={gridContainerRef}
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
						<EmptyState title={`No books match “${trimmedQuery}”`}>
							<Button variant="default" onClick={() => setQuery("")}>
								Clear search
							</Button>
						</EmptyState>
					) : (
						<EmptyState title="No books match these filters.">
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
				width={440}
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
					<BookDetails
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
}

const SaveAsShelfControl = ({
	query,
	sortOrder,
	hideRead,
}: SaveAsShelfControlProps) => {
	const applyShelf = useLibraryView((s) => s.applyShelf);
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

const BookDetails = ({
	book,
	onClose,
}: {
	book: LibraryBook;
	onClose: () => void;
}) => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const canRead = platform.capabilities.canOpenLocalPaths;
	// Books carry only their series NAME; the id that LibraryBookQuery
	// filters on comes from the store's series list (loaded at init and
	// refreshed on mutations). An unresolvable name (shouldn't happen)
	// degrades to plain text.
	const seriesList = useSeriesList();
	const seriesId =
		book.series !== null
			? seriesList.find((series) => series.name === book.series)?.id
			: undefined;
	return (
		<div className={styles.details}>
			<div className={styles.detailsTop}>
				<BookCover book={book} disableFade />
				<div className={styles.detailsInfo}>
					<div className={styles.detailsHeading}>
						<span className={styles.detailsTitle}>{book.title}</span>
						<span className={styles.detailsAuthors}>
							{book.author_list.map((author, index) => (
								<Fragment key={author.id}>
									{index > 0 && ", "}
									<Link
										to="/"
										search={{ author_id: author.id }}
										onClick={onClose}
										className={styles.detailsLink}
									>
										{author.name}
									</Link>
								</Fragment>
							))}
						</span>
						{book.series !== null && (
							<span className={styles.detailsSeries}>
								{book.series_index !== null
									? `Book ${formatSeriesIndex(book.series_index)} of `
									: "Part of "}
								{seriesId !== undefined ? (
									<Link
										to="/"
										search={{ series_id: seriesId }}
										onClick={onClose}
										className={styles.detailsLink}
									>
										{book.series}
									</Link>
								) : (
									book.series
								)}
							</span>
						)}
					</div>
					<div className={styles.detailsActions}>
						{canRead && (
							<Button
								variant="subtle"
								data-drawer-initial-focus=""
								onClick={safeAsyncEventHandler(async () => {
									const firstFile = book.file_list[0];
									if (firstFile === undefined) return;

									const isLocal = "Local" in firstFile;
									if (!isLocal) return;

									await platform.fileOpener.openPath(firstFile.Local.path);
								})}
							>
								Read
							</Button>
						)}
						<Button
							variant="primary"
							data-drawer-initial-focus={canRead ? undefined : ""}
							onClick={() =>
								void navigate({
									to: "/books/$bookId",
									params: { bookId: book.id },
								})
							}
						>
							<F7Pencil />
							Edit
						</Button>
					</div>
				</div>
			</div>
			{book.description !== null && book.description.length > 0 && (
				<>
					<hr className={styles.divider} />
					<div className={styles.detailsBlock}>
						<span className={styles.blockTitle}>Description</span>
						{/* We're using DOMPurify to sanitize the HTML before rendering */}
						<div
							className="description-html"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: We sanitize with DOMPurify
							dangerouslySetInnerHTML={{
								__html: DOMPurify.sanitize(book.description),
							}}
						/>
					</div>
				</>
			)}
			<hr className={styles.divider} />
			<div className={styles.metaStack}>
				{book.tag_list.length > 0 && (
					<div className={styles.metaBlock}>
						<span className={styles.blockTitleSm}>Tags</span>
						<div className={styles.tagRow}>
							{book.tag_list.map((tag) => (
								<span key={tag} className={styles.tagBadge}>
									{tag}
								</span>
							))}
						</div>
					</div>
				)}
				{book.identifier_list.length > 0 && (
					<BookIdentifiers identifier_list={book.identifier_list} />
				)}
				<span className={styles.blockTitle}>Formats</span>
				<p className={styles.formatRow}>
					{book.file_list
						.filter((item): item is { Local: LocalFile } => "Local" in item)
						.map((f1) =>
							platform.capabilities.canRevealInFileManager ? (
								<span
									key={f1.Local.path}
									className={`${styles.formatChip} ${styles.formatChipLink}`}
									onPointerDown={safeAsyncEventHandler(async () => {
										await platform.fileOpener.revealInFileManager(
											f1.Local.path,
										);
									})}
								>
									{f1.Local.mime_type} ↗
								</span>
							) : (
								<span key={f1.Local.path} className={styles.formatChip}>
									{f1.Local.mime_type}
								</span>
							),
						)}
				</p>
			</div>
		</div>
	);
};

const KNOWN_LABELS_TO_SEARCH_URLS = {
	amazon: (value: string) => `https://www.amazon.com/dp/${value}`,
	asin: (value: string) => `https://www.amazon.com/dp/${value}`,
	goodreads: (value: string) => `https://www.goodreads.com/book/show/${value}`,
	google: (value: string) => `https://books.google.com/books?id=${value}`,
	isbn: (value: string) =>
		`https://en.wikipedia.org/wiki/Special:BookSources?isbn=${value}`,
	"mobi-asin": (value: string) => `https://www.amazon.com/dp/${value}`,
	uri: (value: string) => value,
	url: (value: string) => value,
} as const;

const isKnownLabel = (
	label: string,
): label is keyof typeof KNOWN_LABELS_TO_SEARCH_URLS =>
	label in KNOWN_LABELS_TO_SEARCH_URLS;

const BookIdentifiers = ({
	identifier_list,
}: {
	identifier_list: Identifier[];
}) => {
	const platform = usePlatform();
	return (
		<div className={styles.metaBlock}>
			<span className={styles.blockTitleSm}>Identifiers</span>
			<ul className={styles.identifierList}>
				{identifier_list.map(({ label, value }) => {
					if (isKnownLabel(label)) {
						const transformValueToUrl = KNOWN_LABELS_TO_SEARCH_URLS[label];
						const url = transformValueToUrl(value);

						return (
							<li key={label}>
								<span className={styles.identifierEntry}>
									<span className={styles.identifierLabel}>
										{label.toUpperCase()}
									</span>
									:{" "}
									<a
										href={url}
										target="_blank"
										rel={"noreferrer"}
										className={styles.identifierLink}
									>
										{value}
									</a>
									{platform.capabilities.canCopyToClipboard && (
										<IconButton
											aria-label="Copy identifier"
											onPointerDown={safeAsyncEventHandler(async () => {
												await platform.clipboard.writeText(value);
											})}
										>
											<TablerCopy style={{ width: "12px" }} />
										</IconButton>
									)}
								</span>
							</li>
						);
					}
					return (
						<li key={label}>
							<span className={styles.identifierEntry}>
								<span className={styles.identifierLabel}>
									{label.toUpperCase()}
								</span>
								: {value}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
};

export interface BookViewOptions {
	sortOrder: "authorAz" | "authorZa" | "nameAz" | "nameZa";
	searchQuery: string;
}
