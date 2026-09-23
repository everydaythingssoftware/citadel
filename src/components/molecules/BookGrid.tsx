import { useVirtualizer } from "@tanstack/react-virtual";
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { BookView } from "@/BookView";
import type { LibraryBook } from "@/bindings";
import { LoadingOverlay } from "@/components/ui";
import {
	computeColumnCount,
	computeRowCount,
	rowOfIndex,
	rowSlice,
} from "@/lib/grid-virtual";
import { useCoverThumbsMap } from "@/stores/library/store";
import { BookCard } from "../atoms/BookCard";
import cardClasses from "../atoms/BookCard.module.css";

/**
 * Shelf-grid layout constants. The per-row tracks mirror the old
 * `repeat(auto-fill, minmax(150px, 1fr))` whole-grid layout; the
 * virtualizer needs the same numbers to compute cards per row.
 */
const MIN_COLUMN_WIDTH = 150;
const COLUMN_GAP = 24;
const ROW_GAP = 32;
const PADDING = { top: 20, x: 24, bottom: 24 } as const;
/** Cover height cap (BookCover FLUID_MAX_HEIGHT_PX); rows self-measure after mount. */
const ESTIMATED_ROW_HEIGHT = 230;
/** Mirrors `.cell { max-width }` in BookCard.module.css. */
const MAX_CELL_WIDTH = 190;
/**
 * Height/width fallback for covers whose thumbnail (and so real aspect
 * ratio) isn't known yet: classic 2:3 book proportions, matching the
 * unfetched-slot placeholder's `aspect-ratio: 2 / 3`.
 */
const TYPICAL_COVER_RATIO = 1.5;
// Rows pre-mounted beyond the viewport on each side. Cells are cheap since
// covers became 300px thumbnails with reserved boxes, so a deep overscan
// (~1.5 viewports each way) buys fling-scroll headroom. Deep overscan taxes
// update paths instead (every mounted card re-renders on a result-set swap),
// so don't raise it past where fling tests stop improving.
const OVERSCAN_ROWS = 10;

/** Scrolls the shelf row containing the given flat book index into view. */
export type ScrollToBookIndex = (index: number) => void;

/** The inclusive flat-index range of books near the viewport. */
export type VisibleRangeChange = (startIndex: number, endIndex: number) => void;

interface BookGridProps extends BookView {
	/** The page-owned scroll region the virtualizer windows against. */
	scrollElementRef: RefObject<HTMLElement | null>;
	/**
	 * Receives the grid's scroll-to-index function so keyboard selection can
	 * reach rows that are not currently mounted (use-library-keymap).
	 */
	scrollToBookIndexRef?: RefObject<ScrollToBookIndex | null>;
	/**
	 * Fires when the rendered (viewport + overscan) flat-index range moves,
	 * so the owner can page the covered books in (ensureBookRange).
	 */
	onVisibleRangeChange?: VisibleRangeChange;
}

export const BookGrid = ({
	loading,
	bookList,
	onBookOpen,
	selectedBookId,
	scrollElementRef,
	scrollToBookIndexRef,
	onVisibleRangeChange,
}: BookGridProps) => {
	const actionsContext = useMemo(() => {
		return {
			onViewBook: onBookOpen,
		};
	}, [onBookOpen]);

	return (
		<bookActionsContext.Provider value={actionsContext}>
			<BookGridPure
				loading={loading}
				bookList={bookList}
				selectedBookId={selectedBookId}
				scrollElementRef={scrollElementRef}
				scrollToBookIndexRef={scrollToBookIndexRef}
				onVisibleRangeChange={onVisibleRangeChange}
			/>
		</bookActionsContext.Provider>
	);
};

const BookGridPure = ({
	loading,
	bookList: books,
	selectedBookId,
	scrollElementRef,
	scrollToBookIndexRef,
	onVisibleRangeChange,
}: {
	loading: boolean;
	bookList: (LibraryBook | undefined)[];
	selectedBookId?: LibraryBook["id"] | null;
	scrollElementRef: RefObject<HTMLElement | null>;
	scrollToBookIndexRef?: RefObject<ScrollToBookIndex | null>;
	onVisibleRangeChange?: VisibleRangeChange;
}) => {
	const actions = useContext(bookActionsContext);

	const wrapperRef = useRef<HTMLDivElement>(null);
	const [columns, setColumns] = useState(1);
	const [cellWidth, setCellWidth] = useState<number | null>(null);

	// Cards per row come from the container width (auto-fill exists only in
	// layout, so recompute it whenever the panel resizes).
	useLayoutEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;
		const update = () => {
			const availableWidth = wrapper.clientWidth - PADDING.x * 2;
			const nextColumns = computeColumnCount({
				availableWidth,
				minColumnWidth: MIN_COLUMN_WIDTH,
				columnGap: COLUMN_GAP,
			});
			setColumns(nextColumns);
			setCellWidth(
				Math.min(
					(availableWidth - (nextColumns - 1) * COLUMN_GAP) / nextColumns,
					MAX_CELL_WIDTH,
				),
			);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(wrapper);
		return () => observer.disconnect();
	}, []);

	// Exact row heights up front: a row is as tall as its tallest cover, and
	// cover aspect ratios are known before mount (the thumbnail index loads
	// at library open). A wrong estimate isn't cosmetic — when a row mounts
	// above the viewport during upward scrolling, the measure-then-correct
	// delta shifts the whole shelf for a frame.
	const coverThumbs = useCoverThumbsMap();
	const estimateRowHeight = useCallback(
		(rowIndex: number) => {
			if (cellWidth === null) return ESTIMATED_ROW_HEIGHT;
			const { start, end } = rowSlice(rowIndex, columns, books.length);
			let tallest = 0;
			for (let index = start; index < end; index++) {
				const book = books[index];
				const thumb = book !== undefined ? coverThumbs.get(book.id) : undefined;
				// Unknown ratio = a placeholder (unfetched slot or placeholder
				// art), which also caps its width at ~150px (.coverPlaceholder).
				const width =
					thumb !== undefined ? cellWidth : Math.min(cellWidth, 150);
				const ratio =
					thumb !== undefined
						? thumb.height / thumb.width
						: TYPICAL_COVER_RATIO;
				tallest = Math.max(
					tallest,
					Math.min(width * ratio, ESTIMATED_ROW_HEIGHT),
				);
			}
			return tallest > 0 ? Math.round(tallest) : ESTIMATED_ROW_HEIGHT;
		},
		[cellWidth, columns, books, coverThumbs],
	);

	const virtualizer = useVirtualizer({
		count: computeRowCount(books.length, columns),
		getScrollElement: () => scrollElementRef.current,
		estimateSize: estimateRowHeight,
		gap: ROW_GAP,
		overscan: OVERSCAN_ROWS,
		// Rows start below the wrapper's top padding inside the scroll region.
		scrollMargin: PADDING.top,
	});

	// Hand the keymap a way to reach unmounted rows; once the row scrolls in,
	// the selected card mounts and renders its selection ring from props.
	useEffect(() => {
		if (!scrollToBookIndexRef) return;
		scrollToBookIndexRef.current = (index) => {
			virtualizer.scrollToIndex(rowOfIndex(index, columns), {
				align: "auto",
			});
		};
		return () => {
			scrollToBookIndexRef.current = null;
		};
	}, [scrollToBookIndexRef, virtualizer, columns]);

	// Report the rendered row window (includes overscan) as a flat-index
	// range so unfetched pages covering it can load.
	const virtualRows = virtualizer.getVirtualItems();
	const firstRow = virtualRows[0]?.index;
	const lastRow = virtualRows[virtualRows.length - 1]?.index;
	useEffect(() => {
		if (!onVisibleRangeChange) return;
		if (firstRow === undefined || lastRow === undefined) return;
		const start = rowSlice(firstRow, columns, books.length).start;
		const end = rowSlice(lastRow, columns, books.length).end - 1;
		if (end < start) return;
		onVisibleRangeChange(start, end);
	}, [onVisibleRangeChange, firstRow, lastRow, columns, books.length]);

	return (
		<div
			ref={wrapperRef}
			style={{
				// LoadingOverlay covers the nearest position: relative ancestor.
				position: "relative",
				padding: `${PADDING.top}px ${PADDING.x}px ${PADDING.bottom}px`,
			}}
		>
			<LoadingOverlay visible={loading} />
			<div
				style={{
					position: "relative",
					height: virtualizer.getTotalSize(),
				}}
			>
				{/*
				 * Apple Books shelf, windowed: only rows near the viewport mount.
				 * Each virtual row is its own grid with the computed column count;
				 * the row is as tall as its tallest cover and every cell
				 * bottom-aligns its book (see BookCard.module.css) so the bases
				 * sit on one line.
				 */}
				{virtualRows.map((virtualRow) => {
					const { start, end } = rowSlice(
						virtualRow.index,
						columns,
						books.length,
					);
					return (
						<div
							key={virtualRow.key}
							ref={virtualizer.measureElement}
							data-index={virtualRow.index}
							data-books-grid
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${virtualRow.start - PADDING.top}px)`,
								display: "grid",
								gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
								columnGap: COLUMN_GAP,
							}}
						>
							{books.slice(start, end).map((book, offset) =>
								book !== undefined ? (
									<BookCard
										key={book.id}
										book={book}
										actions={actions}
										selected={book.id === selectedBookId}
									/>
								) : (
									// biome-ignore lint/suspicious/noArrayIndexKey: an unfetched slot has no id; its flat grid index IS its identity until the book arrives (and then the keyed BookCard replaces it).
									<BookCardPlaceholder key={`placeholder-${start + offset}`} />
								),
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
};

/**
 * Stand-in cell for a book whose page has not been fetched yet: the same
 * shelf-cell layout as BookCard with a quiet cover-shaped block, so rows
 * keep their height and books pop in without the shelf reflowing.
 */
const BookCardPlaceholder = () => (
	<div className={cardClasses.cell} aria-hidden>
		<span className={cardClasses.coverPlaceholder} />
	</div>
);

type BookAction = (bookId: LibraryBook["id"]) => void;
interface BookActionsContext {
	onViewBook: BookAction;
}
const bookActionsContext = createContext<BookActionsContext>(
	null as unknown as BookActionsContext,
);
