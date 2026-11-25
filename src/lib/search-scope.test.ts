import { describe, expect, it } from "vitest";
import { isSearchScope, SEARCH_SCOPE } from "./search-scope";

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
