import { describe, expect, it } from "vitest";
import type { Identifier } from "@/bindings";
import {
	identifierDisplayName,
	identifierUrl,
	sortIdentifiers,
} from "./book-identifiers";

const id = (label: string, value = "1"): Identifier => ({
	id: 0,
	label,
	value,
});

describe("identifierDisplayName", () => {
	it("names known sources the way people write them", () => {
		expect(identifierDisplayName("openlibrary")).toBe("Open Library");
		expect(identifierDisplayName("HARDCOVER")).toBe("Hardcover");
		expect(identifierDisplayName("isbn")).toBe("ISBN");
		expect(identifierDisplayName("mobi-asin")).toBe("Amazon");
	});

	it("never shouts an unknown source", () => {
		expect(identifierDisplayName("barnesnoble")).toBe("Barnesnoble");
		expect(identifierDisplayName("kobo_store")).toBe("Kobo store");
		expect(identifierDisplayName("ark")).toBe("ARK");
		expect(identifierDisplayName("")).toBe("Identifier");
	});
});

describe("identifierUrl", () => {
	it("links sources that have a page", () => {
		expect(identifierUrl(id("openlibrary", "OL45804W"))).toBe(
			"https://openlibrary.org/works/OL45804W",
		);
		expect(identifierUrl(id("openlibrary", "OL7353617M"))).toBe(
			"https://openlibrary.org/books/OL7353617M",
		);
		expect(identifierUrl(id("goodreads", "42"))).toBe(
			"https://www.goodreads.com/book/show/42",
		);
	});

	it("has no link for ISBNs, unknown sources or non-web URIs", () => {
		expect(identifierUrl(id("isbn", "9780316769488"))).toBeNull();
		expect(identifierUrl(id("barnesnoble"))).toBeNull();
		expect(identifierUrl(id("uri", "javascript:alert(1)"))).toBeNull();
	});
});

describe("sortIdentifiers", () => {
	it("puts ISBN first and unknown sources last", () => {
		expect(
			sortIdentifiers([
				id("zzz"),
				id("goodreads"),
				id("isbn"),
				id("hardcover"),
			]).map((identifier) => identifier.label),
		).toEqual(["isbn", "hardcover", "goodreads", "zzz"]);
	});
});
