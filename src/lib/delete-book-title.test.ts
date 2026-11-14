import { describe, expect, it } from "vitest";
import {
	deleteBookCopy,
	deleteBooksCopy,
	deleteBooksDialogTitle,
} from "./delete-book-title";

describe("deleteBookCopy", () => {
	it("offers recovery from the Trash on desktop", () => {
		const copy = deleteBookCopy("trash");
		expect(copy.confirmLabel).toBe("Move to Trash");
		expect(copy.description).toContain("recover");
	});

	it("says server deletion can't be undone", () => {
		const copy = deleteBookCopy("permanent");
		expect(copy.confirmLabel).toBe("Delete Permanently");
		expect(copy.description).toContain("can't be undone");
		expect(copy.failureTitle).not.toContain("Trash");
	});
});

describe("deleteBooksCopy", () => {
	it("keeps the single-book copy for one book", () => {
		expect(deleteBooksCopy("trash", 1)).toEqual(deleteBookCopy("trash"));
	});

	it("says how many books go and that others stay", () => {
		const copy = deleteBooksCopy("trash", 3);
		expect(copy.description).toContain("These 3 books");
		expect(copy.description).toContain("Other books");
		expect(copy.confirmLabel).toBe("Move to Trash");
		expect(deleteBooksCopy("permanent", 1500).description).toContain(
			"1,500 books",
		);
	});
});

describe("deleteBooksDialogTitle", () => {
	it("names one book and counts several", () => {
		expect(deleteBooksDialogTitle(["Middlemarch"])).toBe(
			"Delete “Middlemarch”?",
		);
		expect(deleteBooksDialogTitle(["A", "B"])).toBe("Delete 2 Books?");
	});
});
