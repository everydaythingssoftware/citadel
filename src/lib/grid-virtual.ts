/**
 * Pure math for the virtualized cover grid (BookGrid.tsx): its layout from
 * a width, index <-> row/column translation, and the scroll anchor that keeps
 * the top row's books in view when the column count changes. The
 * virtualizer windows whole shelf rows; these helpers translate between flat
 * book indices and rows so the grid keeps consuming a plain indexed array.
 */

export interface ColumnMetrics {
	/** Width available to grid tracks (container width minus horizontal padding). */
	availableWidth: number;
	minColumnWidth: number;
	columnGap: number;
}

/**
 * How many `minColumnWidth` tracks fit, gaps between them, as CSS
 * `auto-fill` counts them. Always at least 1.
 */
export const computeColumnCount = ({
	availableWidth,
	minColumnWidth,
	columnGap,
}: ColumnMetrics): number => {
	if (minColumnWidth <= 0) return 1;
	const fit = Math.floor(
		(availableWidth + columnGap) / (minColumnWidth + columnGap),
	);
	return Math.max(fit, 1);
};

export const computeRowCount = (itemCount: number, columns: number): number => {
	if (columns <= 0 || itemCount <= 0) return 0;
	return Math.ceil(itemCount / columns);
};

/** Which row a flat item index lives in. */
export const rowOfIndex = (index: number, columns: number): number =>
	Math.floor(Math.max(index, 0) / Math.max(columns, 1));

export interface RowSlice {
	/** Inclusive start index into the flat item array. */
	start: number;
	/** Exclusive end index — safe to pass straight to Array.prototype.slice. */
	end: number;
}

/** The flat-array slice of items belonging to one row. */
export const rowSlice = (
	row: number,
	columns: number,
	itemCount: number,
): RowSlice => {
	const safeColumns = Math.max(columns, 1);
	const start = Math.min(row * safeColumns, itemCount);
	const end = Math.min(start + safeColumns, itemCount);
	return { start, end };
};

/**
 * The cover grid's shelf metrics. Cells are a fixed 150px; the block of
 * columns is centred in the panel. `padding` is the grid's inset inside
 * the scroll region.
 */
export const BOOK_GRID = {
	cellWidth: 150,
	minColumns: 3,
	columnGap: 24,
	rowGap: 32,
	padding: { top: 20, x: 24, bottom: 24 },
} as const;

export interface BookGridLayout {
	columns: number;
	/** Each column's width: 150px, less when three don't fit. */
	cellWidth: number;
	/** The block's width: the columns and the gaps between them. */
	blockWidth: number;
}

/**
 * The grid for a panel `width` wide: as many 150px columns as fit inside
 * the side padding, and never fewer than three, which then shrink to share
 * the row.
 */
export const bookGridLayout = (width: number): BookGridLayout => {
	const { cellWidth, minColumns, columnGap, padding } = BOOK_GRID;
	const available = Math.max(0, width - padding.x * 2);
	const columns = Math.max(
		minColumns,
		computeColumnCount({
			availableWidth: available,
			minColumnWidth: cellWidth,
			columnGap,
		}),
	);
	const shared = Math.max(0, (available - (columns - 1) * columnGap) / columns);
	const cell = Math.min(cellWidth, shared);
	return {
		columns,
		cellWidth: cell,
		blockWidth: columns * cell + (columns - 1) * columnGap,
	};
};

export const sameBookGridLayout = (
	a: BookGridLayout,
	b: BookGridLayout,
): boolean => a.columns === b.columns && a.cellWidth === b.cellWidth;

/**
 * The panel width the grid lays out for: the panel as it would be with the
 * sidebar open, so opening and closing it never changes the columns. The
 * panel and the sidebar share the window, so whatever one gives up the other
 * gains, and any instant of the sidebar's slide gives the same answer.
 */
export const openSidebarPanelWidth = ({
	panelWidth,
	sidebarWidth,
	openSidebarWidth,
}: {
	panelWidth: number;
	/** The sidebar's width now (0 when closed or overlaying the panel). */
	sidebarWidth: number;
	/** Its width when open (0 when it overlays the panel). */
	openSidebarWidth: number;
}): number => Math.round(panelWidth + sidebarWidth - openSidebarWidth);

/** A row's place in the scroll region (the virtualizer's measurements). */
export interface RowExtent {
	start: number;
	end: number;
}

/** A book and where its row's top sits relative to the viewport's top. */
export interface ScrollAnchor {
	bookIndex: number;
	/** The row's top minus the scroll offset (≤ 0 when it starts above). */
	rowOffset: number;
}

/**
 * The first book of the top visible row: the first row whose bottom is
 * below the viewport's top. Null at the very top, which a relayout should
 * leave alone.
 */
export const topRowAnchor = ({
	rows,
	columns,
	scrollOffset,
}: {
	rows: ArrayLike<RowExtent>;
	columns: number;
	scrollOffset: number;
}): ScrollAnchor | null => {
	if (scrollOffset <= 0 || rows.length === 0) return null;
	let low = 0;
	let high = rows.length - 1;
	while (low < high) {
		const middle = (low + high) >> 1;
		const row = rows[middle];
		if (row !== undefined && row.end > scrollOffset) high = middle;
		else low = middle + 1;
	}
	const row = rows[low];
	if (row === undefined) return null;
	return {
		bookIndex: low * Math.max(columns, 1),
		rowOffset: row.start - scrollOffset,
	};
};

/**
 * The scroll offset that puts the row now holding the anchor's book where
 * its old row was, clamped to the scroll range.
 */
export const anchoredScrollOffset = ({
	anchor,
	rows,
	columns,
	maxOffset,
}: {
	anchor: ScrollAnchor;
	rows: ArrayLike<RowExtent>;
	columns: number;
	maxOffset: number;
}): number => {
	const lastRow = rows.length - 1;
	const row =
		lastRow < 0
			? undefined
			: rows[Math.min(rowOfIndex(anchor.bookIndex, columns), lastRow)];
	if (row === undefined) return 0;
	return Math.max(0, Math.min(row.start - anchor.rowOffset, maxOffset));
};
