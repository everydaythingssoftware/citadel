import { describe, expect, it } from "vitest";
import {
	isSearchScope,
	noMatchesText,
	SEARCH_SCOPE,
	searchPlaceholder,
	searchScopeLabel,
	searchScopeMenuItems,
} from "./search-scope";

describe("search scope", () => {
	it("names the two scopes with the backend values", () => {
		expect(SEARCH_SCOPE).toEqual({
			titlesAuthorsSeries: "titlesAuthorsSeries",
			allFields: "allFields",
		});
	});

	it("accepts only a known scope", () => {
		expect(isSearchScope("titlesAuthorsSeries")).toBe(true);
		expect(isSearchScope("allFields")).toBe(true);
		for (const value of ["AllFields", "true", true, null, undefined, 1]) {
			expect(isSearchScope(value)).toBe(false);
		}
	});
});

describe("search scope label", () => {
	it("gives the name that the scope menu shows", () => {
		expect(searchScopeLabel("titlesAuthorsSeries")).toBe(
			"Titles, Authors & Series",
		);
		expect(searchScopeLabel("allFields")).toBe("All Fields");
	});
});

describe("search scope menu", () => {
	it("checks the current scope and selects each scope", () => {
		const selected: string[] = [];
		const items = searchScopeMenuItems("allFields", (scope) =>
			selected.push(scope),
		);
		expect(
			items.map((entry) =>
				"label" in entry ? [entry.label, entry.checked] : [],
			),
		).toEqual([
			["Titles, Authors & Series", false],
			["All Fields", true],
		]);
		for (const entry of items) if ("onSelect" in entry) entry.onSelect();
		expect(selected).toEqual(["titlesAuthorsSeries", "allFields"]);
	});
});

describe("search placeholder", () => {
	it("names the scope of the search", () => {
		expect(searchPlaceholder("titlesAuthorsSeries")).toBe("Search");
		expect(searchPlaceholder("allFields")).toBe("Search all fields");
	});
});

describe("no matches text", () => {
	it("names the fields of each scope", () => {
		expect(noMatchesText("titlesAuthorsSeries")).toBe(
			"Search looks at titles, authors and series. Check the spelling, or search all fields.",
		);
		expect(noMatchesText("allFields")).toBe(
			"Search looks at titles, authors, series, tags, publishers and identifiers. Check the spelling, or try fewer words.",
		);
	});
});
