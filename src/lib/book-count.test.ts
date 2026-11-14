import { describe, expect, it } from "vitest";
import {
	bookCountStatus,
	booksTitle,
	formatCount,
	pluralize,
} from "./book-count";

describe("pluralize", () => {
	it("uses the singular for exactly one", () => {
		expect(pluralize(1, "book")).toBe("1 book");
	});

	it("uses the plural for zero and many, with thousands separators", () => {
		expect(pluralize(0, "book")).toBe("0 books");
		expect(pluralize(2, "book")).toBe("2 books");
		expect(pluralize(1204, "book")).toBe("1,204 books");
	});

	it("takes an irregular plural", () => {
		expect(pluralize(3, "series", "series")).toBe("3 series");
	});
});

describe("booksTitle", () => {
	it("reads as a title-case noun", () => {
		expect(booksTitle(1)).toBe("Book");
		expect(booksTitle(2)).toBe("2 Books");
		expect(booksTitle(1500)).toBe("1,500 Books");
	});
});

describe("formatCount", () => {
	it("groups thousands", () => {
		expect(formatCount(1234567)).toBe("1,234,567");
	});
});

describe("bookCountStatus", () => {
	const base = { loading: false, total: 1, libraryTotal: 1, selectedCount: 0 };

	it("says “1 book”, not “1 books”", () => {
		expect(bookCountStatus(base)).toBe("1 book");
	});

	it("shows the filtered share of the library", () => {
		expect(bookCountStatus({ ...base, total: 1, libraryTotal: 1204 })).toBe(
			"1 of 1,204 books",
		);
		expect(bookCountStatus({ ...base, total: 40, libraryTotal: 1204 })).toBe(
			"40 of 1,204 books",
		);
	});

	it("falls back to the result size while the library size is unknown", () => {
		expect(bookCountStatus({ ...base, total: 12, libraryTotal: null })).toBe(
			"12 books",
		);
	});

	it("shows the selection once more than one book is selected", () => {
		expect(
			bookCountStatus({
				...base,
				total: 1204,
				libraryTotal: 1204,
				selectedCount: 3,
			}),
		).toBe("3 of 1,204 selected");
		expect(
			bookCountStatus({
				...base,
				total: 1204,
				libraryTotal: 1204,
				selectedCount: 1,
			}),
		).toBe("1,204 books");
	});

	it("says it is loading", () => {
		expect(bookCountStatus({ ...base, loading: true })).toBe("Loading books…");
	});
});
