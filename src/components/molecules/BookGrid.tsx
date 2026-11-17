import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
} from "react";
import type { LibraryBook } from "@/bindings";
import { LoadingOverlay } from "@/components/ui";
import {
	anchoredScrollOffset,
	BOOK_GRID,
	computeRowCount,
	rowOfIndex,
	rowSlice,
	type ScrollAnchor,
	topRowAnchor,
} from "@/lib/grid-virtual";
import type { BookCardActions } from "@/lib/hooks/use-book-grid-interaction";
import { useBookGridLayout } from "@/lib/hooks/use-book-grid-layout";
import { useCoverThumbsMap } from "@/stores/library/store";
import { BookCard } from "../atoms/BookCard";
import cardClasses from "../atoms/BookCard.module.css";

const { columnGap: COLUMN_GAP, rowGap: ROW_GAP, padding: PADDING } = BOOK_GRID;
/** Cover height cap (BookCover FLUID_MAX_HEIGHT_PX); rows self-measure after mount. */
const ESTIMATED_ROW_HEIGHT = 230;
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

/** What the keyboard needs of the windowed grid (use-library-keymap). */
export interface BookGridHandle {
	columns: number;
	/** Scrolls the shelf row holding this flat book index into view. */
	scrollToIndex(index: number): void;
}

/** The inclusive flat-index range of books near the viewport. */
export type VisibleRangeChange = (startIndex: number, endIndex: number) => void;

interface BookGridProps {
	loading: boolean;
	/**
	 * Indexed array of the filtered library: length is the total match
	 * count, `undefined` entries are books whose page has not been fetched
	 * yet (they render as placeholders).
	 */
	bookList: (LibraryBook | undefined)[];
	/** Press, right-click and drag on a cover. */
	cardActions: BookCardActions;
	/** Membership in the selection, by id (and index, for pending slots). */
	isSelected: (bookId: LibraryBook["id"], index: number) => boolean;
	/** The page-owned scroll region the virtualizer windows against. */
	scrollElementRef: RefObject<HTMLElement | null>;
	/** Where the scroll region starts when the grid mounts. */
	initialScrollOffset?: number;
	/**
	 * Changes when a different result set is shown. Row heights measured for
	 * the previous set no longer apply, so they are dropped and re-estimated.
	 */
	resultKey?: string;
	/**
	 * Receives the grid's column count and a way to reach rows that are not
	 * mounted, for keyboard selection.
	 */
	handleRef?: RefObject<BookGridHandle | null>;
	/**
	 * Fires when the rendered (viewport + overscan) flat-index range moves,
	 * so the owner can page the covered books in (ensureBookRange).
	 */
	onVisibleRangeChange?: VisibleRangeChange;
}

export const BookGrid = ({
	loading,
	bookList: books,
	cardActions,
	isSelected,
	scrollElementRef,
	initialScrollOffset,
	resultKey,
	handleRef,
	onVisibleRangeChange,
}: BookGridProps) => {
	const wrapperRef = useRef<HTMLDivElement>(null);
	// The top row's first book, noted just before the columns change, so the
	// new layout can put its row back where it was (see the effect below).
	const anchorRef = useRef<ScrollAnchor | null>(null);
	const noteAnchorRef = useRef<(() => void) | null>(null);
	const layout = useBookGridLayout({
		wrapperRef,
		onWillRelayout: () => noteAnchorRef.current?.(),
	});
	const { columns, cellWidth } = layout;

	// Exact row heights up front: a row is as tall as its tallest cover, and
	// cover aspect ratios are known before mount (the thumbnail index loads
	// at library open). A wrong estimate isn't cosmetic — when a row mounts
	// above the viewport during upward scrolling, the measure-then-correct
	// delta shifts the whole shelf for a frame.
	const coverThumbs = useCoverThumbsMap();
	const estimateRowHeight = useCallback(
		(rowIndex: number) => {
			const { start, end } = rowSlice(rowIndex, columns, books.length);
			let tallest = 0;
			for (let index = start; index < end; index++) {
				const book = books[index];
				const thumb = book !== undefined ? coverThumbs.get(book.id) : undefined;
				// Unknown ratio = a placeholder (unfetched slot or placeholder
				// art), as wide as the cell at the typical 2:3.
				const ratio =
					thumb !== undefined
						? thumb.height / thumb.width
						: TYPICAL_COVER_RATIO;
				tallest = Math.max(
					tallest,
					Math.min(cellWidth * ratio, ESTIMATED_ROW_HEIGHT),
				);
			}
			return tallest > 0 ? Math.round(tallest) : ESTIMATED_ROW_HEIGHT;
		},
		[cellWidth, columns, books, coverThumbs],
	);

	// Rows are keyed by layout as well as index: a new column count regroups
	// every row, so sizes measured for the old rows must not carry over, and
	// the exact estimates take their place without a measure-then-correct.
	const getRowKey = useCallback(
		(rowIndex: number) => `${columns}x${cellWidth}:${rowIndex}`,
		[columns, cellWidth],
	);

	const virtualizer = useVirtualizer({
		count: computeRowCount(books.length, columns),
		getScrollElement: () => scrollElementRef.current,
		estimateSize: estimateRowHeight,
		getItemKey: getRowKey,
		gap: ROW_GAP,
		overscan: OVERSCAN_ROWS,
		// Rows start below the wrapper's top padding inside the scroll region.
		scrollMargin: PADDING.top,
		initialOffset: initialScrollOffset,
	});

	const measuredForRef = useRef(resultKey);
	useLayoutEffect(() => {
		if (measuredForRef.current === resultKey) return;
		measuredForRef.current = resultKey;
		virtualizer.measure();
	}, [resultKey, virtualizer]);

	// Keep the top-left book in view when the columns change (a window
	// resize, a drag of the sidebar's edge): note the top row's first book
	// and its distance from the viewport's top while the old rows are still
	// laid out, then scroll its new row to the same distance before the
	// frame paints. The virtualizer learns the offset at once and renders
	// again, so the rows around it are the ones that mount. At the very top
	// there is no anchor and the grid stays there.
	noteAnchorRef.current = () => {
		const element = scrollElementRef.current;
		anchorRef.current = element
			? topRowAnchor({
					rows: virtualizer.measurementsCache,
					columns,
					scrollOffset: element.scrollTop,
				})
			: null;
	};
	const [, renderAgain] = useReducer((count: number) => count + 1, 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the layout changes, after the virtualizer has taken the new rows.
	useLayoutEffect(() => {
		const anchor = anchorRef.current;
		anchorRef.current = null;
		const element = scrollElementRef.current;
		if (anchor === null || !element) return;
		element.scrollTop = anchoredScrollOffset({
			anchor,
			rows: virtualizer.measurementsCache,
			columns,
			maxOffset: element.scrollHeight - element.clientHeight,
		});
		virtualizer.scrollOffset = element.scrollTop;
		renderAgain();
	}, [columns, cellWidth]);

	// Once a row scrolls in, the selected card mounts and renders its
	// selection ring from props.
	useEffect(() => {
		if (!handleRef) return;
		handleRef.current = {
			columns,
			scrollToIndex: (index) =>
				virtualizer.scrollToIndex(rowOfIndex(index, columns), {
					align: "auto",
				}),
		};
		return () => {
			handleRef.current = null;
		};
	}, [handleRef, virtualizer, columns]);

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
			role="presentation"
			style={{
				// LoadingOverlay covers the nearest position: relative ancestor.
				position: "relative",
				padding: `${PADDING.top}px ${PADDING.x}px ${PADDING.bottom}px`,
			}}
		>
			<LoadingOverlay visible={loading} />
			<div
				role="presentation"
				style={{
					position: "relative",
					height: virtualizer.getTotalSize(),
					// The block of columns, centred: a sidebar toggle only slides it.
					width: layout.blockWidth,
					marginInline: "auto",
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
							role="presentation"
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${virtualRow.start - PADDING.top}px)`,
								display: "grid",
								gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)`,
								columnGap: COLUMN_GAP,
							}}
						>
							{books.slice(start, end).map((book, offset) =>
								book !== undefined ? (
									<BookCard
										key={book.id}
										book={book}
										index={start + offset}
										setSize={books.length}
										actions={cardActions}
										selected={isSelected(book.id, start + offset)}
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
	<div className={cardClasses.cell} aria-hidden="true">
		<span className={cardClasses.coverPlaceholder} />
	</div>
);
