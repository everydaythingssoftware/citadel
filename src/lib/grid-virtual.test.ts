import { describe, expect, it } from "vitest";
import {
	anchoredScrollOffset,
	bookGridLayout,
	computeColumnCount,
	computeRowCount,
	openSidebarPanelWidth,
	type RowExtent,
	rowOfIndex,
	rowSlice,
	topRowAnchor,
} from "./grid-virtual";

describe("computeColumnCount", () => {
	const metrics = { minColumnWidth: 150, columnGap: 24 };

	it("fits as many min-width tracks as possible, gaps between them", () => {
		// 5 tracks need 5*150 + 4*24 = 846px.
		expect(computeColumnCount({ ...metrics, availableWidth: 846 })).toBe(5);
		expect(computeColumnCount({ ...metrics, availableWidth: 845 })).toBe(4);
	});

	it("matches CSS auto-fill at exact track boundaries", () => {
		// 2 tracks need 150 + 24 + 150 = 324px.
		expect(computeColumnCount({ ...metrics, availableWidth: 324 })).toBe(2);
		expect(computeColumnCount({ ...metrics, availableWidth: 323 })).toBe(1);
	});

	it("never reports fewer than one column", () => {
		expect(computeColumnCount({ ...metrics, availableWidth: 0 })).toBe(1);
		expect(computeColumnCount({ ...metrics, availableWidth: -50 })).toBe(1);
	});

	it("guards against a non-positive min column width", () => {
		expect(
			computeColumnCount({
				availableWidth: 800,
				minColumnWidth: 0,
				columnGap: 24,
			}),
		).toBe(1);
	});
});

describe("computeRowCount", () => {
	it("rounds partial rows up", () => {
		expect(computeRowCount(10, 4)).toBe(3);
		expect(computeRowCount(8, 4)).toBe(2);
		expect(computeRowCount(1, 4)).toBe(1);
	});

	it("is zero for an empty list", () => {
		expect(computeRowCount(0, 4)).toBe(0);
	});

	it("is zero when there are no columns", () => {
		expect(computeRowCount(10, 0)).toBe(0);
	});
});

describe("rowOfIndex", () => {
	it("maps flat indices onto rows", () => {
		expect(rowOfIndex(0, 4)).toBe(0);
		expect(rowOfIndex(3, 4)).toBe(0);
		expect(rowOfIndex(4, 4)).toBe(1);
		expect(rowOfIndex(11, 4)).toBe(2);
	});

	it("clamps negative indices to the first row", () => {
		expect(rowOfIndex(-1, 4)).toBe(0);
	});

	it("treats a degenerate column count as a single column", () => {
		expect(rowOfIndex(3, 0)).toBe(3);
	});
});

describe("rowSlice", () => {
	it("slices full rows", () => {
		expect(rowSlice(0, 4, 10)).toEqual({ start: 0, end: 4 });
		expect(rowSlice(1, 4, 10)).toEqual({ start: 4, end: 8 });
	});

	it("truncates the partial last row", () => {
		expect(rowSlice(2, 4, 10)).toEqual({ start: 8, end: 10 });
	});

	it("yields an empty slice past the end", () => {
		expect(rowSlice(3, 4, 10)).toEqual({ start: 10, end: 10 });
	});

	it("round-trips with rowOfIndex", () => {
		const columns = 5;
		const itemCount = 23;
		for (let index = 0; index < itemCount; index += 1) {
			const { start, end } = rowSlice(
				rowOfIndex(index, columns),
				columns,
				itemCount,
			);
			expect(index).toBeGreaterThanOrEqual(start);
			expect(index).toBeLessThan(end);
		}
	});
});

describe("bookGridLayout", () => {
	it("packs fixed 150px cells with 24px gaps", () => {
		// A 920px window, 220px sidebar + hairline: a 699px panel.
		expect(bookGridLayout(699)).toEqual({
			columns: 3,
			cellWidth: 150,
			blockWidth: 3 * 150 + 2 * 24,
		});
		// 1500px window: 1279px panel, 1231px inside the padding → 7 columns.
		expect(bookGridLayout(1279)).toEqual({
			columns: 7,
			cellWidth: 150,
			blockWidth: 7 * 150 + 6 * 24,
		});
	});

	it("adds a column exactly where one more cell and gap fit", () => {
		// 5 columns need 5*150 + 4*24 = 846px plus 48px of padding.
		expect(bookGridLayout(894).columns).toBe(5);
		expect(bookGridLayout(893).columns).toBe(4);
	});

	it("keeps three columns, sharing the row, when three cells don't fit", () => {
		const phone = bookGridLayout(390);
		expect(phone.columns).toBe(3);
		expect(phone.cellWidth).toBeCloseTo((390 - 48 - 48) / 3);
		expect(phone.blockWidth).toBeCloseTo(390 - 48);
	});

	it("never goes negative in a degenerate panel", () => {
		expect(bookGridLayout(0)).toEqual({
			columns: 3,
			cellWidth: 0,
			blockWidth: 48,
		});
	});
});

describe("openSidebarPanelWidth", () => {
	it("gives the panel what the sidebar gives up", () => {
		expect(
			openSidebarPanelWidth({
				panelWidth: 699,
				sidebarWidth: 220,
				openSidebarWidth: 220,
			}),
		).toBe(699);
		expect(
			openSidebarPanelWidth({
				panelWidth: 919,
				sidebarWidth: 0,
				openSidebarWidth: 220,
			}),
		).toBe(699);
	});

	it("gives the same answer at any instant of the slide", () => {
		expect(
			openSidebarPanelWidth({
				panelWidth: 812.4,
				sidebarWidth: 106.6,
				openSidebarWidth: 220,
			}),
		).toBe(699);
	});

	it("is the panel alone where the sidebar takes no width", () => {
		expect(
			openSidebarPanelWidth({
				panelWidth: 390,
				sidebarWidth: 0,
				openSidebarWidth: 0,
			}),
		).toBe(390);
	});
});

/** Rows as the virtualizer lays them out: from the top padding, gaps between. */
const rowsOf = (heights: number[], margin = 20, gap = 32): RowExtent[] => {
	let start = margin;
	return heights.map((height) => {
		const row = { start, end: start + height };
		start += height + gap;
		return row;
	});
};

describe("topRowAnchor", () => {
	const rows = rowsOf([225, 200, 230, 180, 225, 225]);

	it("is null at the very top", () => {
		expect(topRowAnchor({ rows, columns: 5, scrollOffset: 0 })).toBeNull();
	});

	it("takes the first row still showing below the viewport's top", () => {
		// Row 1 runs 277–477; row 2 starts at 509.
		expect(topRowAnchor({ rows, columns: 5, scrollOffset: 300 })).toEqual({
			bookIndex: 5,
			rowOffset: 277 - 300,
		});
		expect(topRowAnchor({ rows, columns: 5, scrollOffset: 476 })).toEqual({
			bookIndex: 5,
			rowOffset: 277 - 476,
		});
	});

	it("takes the row below when the viewport's top is in a gap", () => {
		expect(topRowAnchor({ rows, columns: 5, scrollOffset: 490 })).toEqual({
			bookIndex: 10,
			rowOffset: 509 - 490,
		});
	});

	it("is null with no rows, or past the last one", () => {
		expect(
			topRowAnchor({ rows: [], columns: 5, scrollOffset: 300 }),
		).toBeNull();
		const last = rows[rows.length - 1];
		expect(
			topRowAnchor({ rows, columns: 5, scrollOffset: (last?.end ?? 0) + 10 }),
		).toEqual({
			bookIndex: 25,
			rowOffset: (last?.start ?? 0) - ((last?.end ?? 0) + 10),
		});
	});
});

describe("anchoredScrollOffset", () => {
	it("puts the book's new row where its old row was", () => {
		// 5 → 6 columns: book 10 moves from row 2 to row 1.
		const before = rowsOf([225, 200, 230, 180]);
		const anchor = topRowAnchor({
			rows: before,
			columns: 5,
			scrollOffset: 530,
		});
		expect(anchor).toEqual({ bookIndex: 10, rowOffset: 509 - 530 });
		const after = rowsOf([230, 225, 225]);
		expect(
			anchoredScrollOffset({
				anchor: anchor ?? { bookIndex: 0, rowOffset: 0 },
				rows: after,
				columns: 6,
				maxOffset: 10_000,
			}),
		).toBe(282 + 21);
	});

	it("keeps the anchor book in the top row when columns drop", () => {
		// 6 → 4 columns: book 12 (row 2) moves to row 3.
		const after = rowsOf([200, 200, 200, 200, 200]);
		expect(
			anchoredScrollOffset({
				anchor: { bookIndex: 12, rowOffset: -40 },
				rows: after,
				columns: 4,
				maxOffset: 10_000,
			}),
		).toBe(20 + 3 * 232 + 40);
	});

	it("clamps to the scroll range", () => {
		const after = rowsOf([200, 200, 200]);
		expect(
			anchoredScrollOffset({
				anchor: { bookIndex: 8, rowOffset: -10 },
				rows: after,
				columns: 4,
				maxOffset: 300,
			}),
		).toBe(300);
		expect(
			anchoredScrollOffset({
				anchor: { bookIndex: 0, rowOffset: 40 },
				rows: after,
				columns: 4,
				maxOffset: 300,
			}),
		).toBe(0);
	});

	it("falls back to the last row for a book past the end", () => {
		const after = rowsOf([200, 200]);
		expect(
			anchoredScrollOffset({
				anchor: { bookIndex: 40, rowOffset: 0 },
				rows: after,
				columns: 4,
				maxOffset: 10_000,
			}),
		).toBe(252);
		expect(
			anchoredScrollOffset({
				anchor: { bookIndex: 4, rowOffset: 0 },
				rows: [],
				columns: 4,
				maxOffset: 10_000,
			}),
		).toBe(0);
	});
});
