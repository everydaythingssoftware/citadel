import { describe, expect, it } from "vitest";
import { SEARCH_SCOPE } from "./search-scope";

describe("search scope", () => {
	it("names the two scopes with the backend values", () => {
		expect(SEARCH_SCOPE).toEqual({
			titlesAuthorsSeries: "titlesAuthorsSeries",
			allFields: "allFields",
		});
	});
});
