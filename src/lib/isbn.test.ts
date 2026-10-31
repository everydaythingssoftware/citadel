import { describe, expect, it } from "vitest";
import { normalizeIsbn } from "./isbn";

describe("normalizeIsbn", () => {
	it("accepts a bare ISBN-13", () => {
		expect(normalizeIsbn("9780316212366")).toBe("9780316212366");
	});

	it("accepts a bare ISBN-10", () => {
		expect(normalizeIsbn("0316212369")).toBe("0316212369");
	});

	it("accepts an ISBN-10 with an X check digit and uppercases it", () => {
		expect(normalizeIsbn("097522980X")).toBe("097522980X");
		expect(normalizeIsbn("097522980x")).toBe("097522980X");
	});

	it("strips an 'ISBN:' prefix regardless of case", () => {
		expect(normalizeIsbn("ISBN:9780316212366")).toBe("9780316212366");
		expect(normalizeIsbn("isbn: 9780316212366")).toBe("9780316212366");
	});

	it("handles a 'urn:isbn:' prefix", () => {
		expect(normalizeIsbn("urn:isbn:9780316212366")).toBe("9780316212366");
		expect(normalizeIsbn("urn:isbn:097522980X")).toBe("097522980X");
	});

	it("strips hyphens and spaces", () => {
		expect(normalizeIsbn("978-0-316-21236-6")).toBe("9780316212366");
		expect(normalizeIsbn("978 0 316 21236 6")).toBe("9780316212366");
		expect(normalizeIsbn("0-9752298-0-X")).toBe("097522980X");
	});

	it("returns undefined for invalid lengths", () => {
		expect(normalizeIsbn("12345")).toBeUndefined();
		expect(normalizeIsbn("978031621236")).toBeUndefined(); // 12 digits
		expect(normalizeIsbn("97803162123666")).toBeUndefined(); // 14 digits
	});

	it("returns undefined for garbage input", () => {
		expect(normalizeIsbn("not-an-isbn")).toBeUndefined();
		expect(normalizeIsbn("uuid:1234-5678")).toBeUndefined();
	});

	it("returns undefined when X is not the final ISBN-10 character", () => {
		expect(normalizeIsbn("09752X9800")).toBeUndefined();
	});

	it("returns undefined for an empty or whitespace-only string", () => {
		expect(normalizeIsbn("")).toBeUndefined();
		expect(normalizeIsbn("   ")).toBeUndefined();
	});
});

describe("formatIsbn and isbnProblem", () => {
	it("hyphenates valid ISBN-10s and ISBN-13s by registration range", async () => {
		const { formatIsbn } = await import("./isbn");
		expect(formatIsbn("9780141439518")).toBe("978-0-14-143951-8");
		expect(formatIsbn("0141439513")).toBe("0-14-143951-3");
		expect(formatIsbn("urn:isbn:978-1-234-56789-7")).toBe("978-1-234-56789-7");
		expect(formatIsbn("ISBN 0-14-143951-3")).toBe("0-14-143951-3");
		expect(formatIsbn("9780141439519")).toBeUndefined();
		expect(formatIsbn("")).toBeUndefined();
	});

	it("explains what's wrong with a typed ISBN", async () => {
		const { isbnProblem } = await import("./isbn");
		expect(isbnProblem("")).toBeUndefined();
		expect(isbnProblem("978-0-14-143951-8")).toBeUndefined();
		expect(isbnProblem("9780141439519")).toBe(
			"This ISBN's check digit doesn't match",
		);
		expect(isbnProblem("97801")).toBe("An ISBN has 10 or 13 digits");
	});
});
