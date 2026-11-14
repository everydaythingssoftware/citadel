import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import {
	type BookSelection,
	bookClickIntent,
	clearSelection,
	emptySelection,
	extendSelection,
	isBookSelected,
	isSelectionEmpty,
	materializePending,
	movedBeyondClickSlop,
	selectAll,
	selectedBookCount,
	selectedBooks,
	selectForContextMenu,
	selectOnly,
	toggleBook,
	unresolvedRange,
} from "./book-selection";

const book = (id: string, isRead = false): LibraryBook => ({
	id,
	uuid: null,
	title: `Title ${id}`,
	author_list: [],
	tag_list: [],
	sortable_title: null,
	file_list: [],
	cover_image: null,
	identifier_list: [],
	description: null,
	is_read: isRead,
	series: null,
	series_index: null,
	language_list: [],
	added_at: "2025-01-01T00:00:00Z",
});

const shelf = (count: number): (LibraryBook | undefined)[] =>
	Array.from({ length: count }, (_, index) => book(`b${index}`));

const ids = (selection: BookSelection) => [...selection.ids].sort();

describe("selectOnly", () => {
	it("selects one book and anchors there", () => {
		const selection = selectOnly(3, "b3");
		expect(ids(selection)).toEqual(["b3"]);
		expect(selection.anchor).toBe(3);
		expect(selection.cursor).toBe(3);
		expect(selection.pending).toBeNull();
	});

	it("marks an unfetched slot pending so it selects once it arrives", () => {
		const selection = selectOnly(7, undefined);
		expect(selection.ids.size).toBe(0);
		expect(selection.pending).toEqual({ start: 7, end: 7 });
		expect(selectedBookCount(selection, 10)).toBe(1);
	});
});

describe("toggleBook", () => {
	it("adds and removes books and moves the anchor", () => {
		let selection = selectOnly(0, "b0");
		selection = toggleBook(selection, 4, "b4");
		expect(ids(selection)).toEqual(["b0", "b4"]);
		expect(selection.anchor).toBe(4);
		selection = toggleBook(selection, 0, "b0");
		expect(ids(selection)).toEqual(["b4"]);
	});

	it("excludes a book from Select All", () => {
		const selection = toggleBook(selectAll(emptySelection), 2, "b2");
		expect(selection.mode).toBe("all");
		expect(isBookSelected(selection, "b2")).toBe(false);
		expect(isBookSelected(selection, "b3")).toBe(true);
		expect(selectedBookCount(selection, 10)).toBe(9);
		const back = toggleBook(selection, 2, "b2");
		expect(isBookSelected(back, "b2")).toBe(true);
	});
});

describe("extendSelection", () => {
	it("selects the range from the anchor in either direction", () => {
		const books = shelf(10);
		const down = extendSelection(selectOnly(2, "b2"), 5, books);
		expect(ids(down)).toEqual(["b2", "b3", "b4", "b5"]);
		expect(down.anchor).toBe(2);
		expect(down.cursor).toBe(5);
		const up = extendSelection(selectOnly(5, "b5"), 3, books);
		expect(ids(up)).toEqual(["b3", "b4", "b5"]);
	});

	it("replaces the previous range rather than growing it", () => {
		const books = shelf(10);
		const first = extendSelection(selectOnly(2, "b2"), 6, books);
		const second = extendSelection(first, 3, books);
		expect(ids(second)).toEqual(["b2", "b3"]);
	});

	it("keeps ⌘-clicked books outside the range", () => {
		const books = shelf(10);
		const toggled = toggleBook(selectOnly(0, "b0"), 5, "b5");
		const extended = extendSelection(toggled, 7, books);
		expect(ids(extended)).toEqual(["b0", "b5", "b6", "b7"]);
	});

	it("starts from the clicked book when there is no anchor", () => {
		const extended = extendSelection(emptySelection, 4, shelf(10));
		expect(ids(extended)).toEqual(["b4"]);
	});

	it("leaves unfetched slots pending", () => {
		const books = shelf(10);
		books[4] = undefined;
		books[5] = undefined;
		const extended = extendSelection(selectOnly(2, "b2"), 7, books);
		expect(ids(extended)).toEqual(["b2", "b3", "b6", "b7"]);
		expect(extended.pending).toEqual({ start: 4, end: 5 });
		expect(selectedBookCount(extended, 10)).toBe(6);
		expect(isBookSelected(extended, "x", 4)).toBe(true);
		expect(unresolvedRange(extended, 10)).toEqual({ start: 4, end: 5 });
	});

	it("turns Select All into a range", () => {
		const extended = extendSelection(
			selectAll(selectOnly(1, "b1")),
			3,
			shelf(10),
		);
		expect(extended.mode).toBe("some");
		expect(ids(extended)).toEqual(["b1", "b2", "b3"]);
	});
});

describe("materializePending", () => {
	it("adds arrived books and narrows what is still pending", () => {
		const books = shelf(10);
		books[4] = undefined;
		books[5] = undefined;
		const extended = extendSelection(selectOnly(2, "b2"), 7, books);
		const partly = [...books];
		partly[4] = book("b4");
		const narrowed = materializePending(extended, partly);
		expect(ids(narrowed)).toContain("b4");
		expect(narrowed.pending).toEqual({ start: 5, end: 5 });
		const done = materializePending(narrowed, shelf(10));
		expect(done.pending).toBeNull();
		expect(selectedBookCount(done, 10)).toBe(6);
	});

	it("returns the same selection when nothing arrived", () => {
		const selection = selectOnly(3, undefined);
		const books = shelf(10);
		books[3] = undefined;
		expect(materializePending(selection, books)).toBe(selection);
	});

	it("drops pending indices past the end of a shrunk result", () => {
		const selection = selectOnly(30, undefined);
		expect(materializePending(selection, shelf(10)).pending).toBeNull();
	});
});

describe("selectAll", () => {
	it("covers unfetched books without naming them", () => {
		const selection = selectAll(selectOnly(1, "b1"));
		expect(selection.mode).toBe("all");
		expect(selectedBookCount(selection, 1204)).toBe(1204);
		expect(isBookSelected(selection, "anything")).toBe(true);
		expect(unresolvedRange(selection, 1204)).toEqual({ start: 0, end: 1203 });
		expect(selection.cursor).toBe(1);
	});

	it("is empty over an empty result", () => {
		expect(isSelectionEmpty(selectAll(emptySelection), 0)).toBe(true);
		expect(unresolvedRange(selectAll(emptySelection), 0)).toBeNull();
	});
});

describe("clearSelection", () => {
	it("empties the selection but keeps the keyboard position", () => {
		const cleared = clearSelection(
			extendSelection(selectOnly(1, "b1"), 4, shelf(6)),
		);
		expect(isSelectionEmpty(cleared, 6)).toBe(true);
		expect(cleared.cursor).toBe(4);
	});
});

describe("selectedBooks", () => {
	it("lists loaded selected books in grid order", () => {
		const books = shelf(6);
		const selection = toggleBook(selectOnly(4, "b4"), 1, "b1");
		expect(selectedBooks(selection, books).map(({ id }) => id)).toEqual([
			"b1",
			"b4",
		]);
	});

	it("lists every loaded book but the excluded under Select All", () => {
		const books = shelf(4);
		const selection = toggleBook(selectAll(emptySelection), 2, "b2");
		expect(selectedBooks(selection, books).map(({ id }) => id)).toEqual([
			"b0",
			"b1",
			"b3",
		]);
	});

	it("ignores ids that are no longer in the result", () => {
		const selection = toggleBook(selectOnly(0, "gone"), 1, "b1");
		expect(selectedBooks(selection, shelf(3)).map(({ id }) => id)).toEqual([
			"b1",
		]);
	});

	it("returns nothing for an empty selection", () => {
		expect(selectedBooks(emptySelection, shelf(3))).toEqual([]);
	});
});

describe("selectForContextMenu", () => {
	it("keeps the selection when right-clicking a selected book", () => {
		const selection = extendSelection(selectOnly(0, "b0"), 2, shelf(5));
		expect(selectForContextMenu(selection, 1, "b1")).toBe(selection);
	});

	it("selects just the book when right-clicking outside the selection", () => {
		const selection = extendSelection(selectOnly(0, "b0"), 2, shelf(5));
		expect(ids(selectForContextMenu(selection, 4, "b4"))).toEqual(["b4"]);
	});
});

describe("bookClickIntent", () => {
	const plain = { metaKey: false, ctrlKey: false, shiftKey: false, detail: 1 };
	const mac = { isMac: true };
	const windows = { isMac: false };

	it("shows the details on a click and opens the file on a double-click", () => {
		for (const env of [mac, windows]) {
			expect(bookClickIntent(plain, env)).toBe("show");
			expect(bookClickIntent({ ...plain, detail: 2 }, env)).toBe("open");
		}
	});

	it("opens once however many clicks follow", () => {
		expect(bookClickIntent({ ...plain, detail: 3 }, mac)).toBe("none");
		expect(bookClickIntent({ ...plain, detail: 4 }, mac)).toBe("none");
	});

	it("treats a press with no click count (a tap, a synthetic click) as a click", () => {
		expect(bookClickIntent({ ...plain, detail: 0 }, mac)).toBe("show");
	});

	it("toggles with ⌘ on the Mac and Ctrl elsewhere, without the details", () => {
		expect(bookClickIntent({ ...plain, metaKey: true }, mac)).toBe("toggle");
		expect(bookClickIntent({ ...plain, ctrlKey: true }, mac)).toBe("show");
		expect(bookClickIntent({ ...plain, ctrlKey: true }, windows)).toBe(
			"toggle",
		);
		expect(bookClickIntent({ ...plain, metaKey: true, detail: 2 }, mac)).toBe(
			"toggle",
		);
	});

	it("extends with ⇧, even on the second click", () => {
		expect(bookClickIntent({ ...plain, shiftKey: true }, mac)).toBe("extend");
		expect(
			bookClickIntent({ ...plain, shiftKey: true, detail: 2 }, windows),
		).toBe("extend");
	});
});

describe("movedBeyondClickSlop", () => {
	it("treats small jitters as a click and real moves as a drag", () => {
		expect(movedBeyondClickSlop({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(false);
		expect(movedBeyondClickSlop({ x: 0, y: 0 }, { x: 0, y: 12 })).toBe(true);
	});
});
