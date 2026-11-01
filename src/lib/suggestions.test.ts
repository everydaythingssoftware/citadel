import { describe, expect, it } from "vitest";
import { exactMatchIndex, rankSuggestions } from "./suggestions";

const TAGS = [
	"American Science Fiction And Fantasy",
	"Fiction - Science Fiction",
	"Fiction / Science Fiction / Space Opera",
	"Science Fiction",
	"Science",
	"Conscience",
	"Fantasy",
];

describe("rankSuggestions", () => {
	it("needs two characters before suggesting anything", () => {
		expect(rankSuggestions(TAGS, [], "")).toEqual([]);
		expect(rankSuggestions(TAGS, [], " s ")).toEqual([]);
		expect(rankSuggestions(TAGS, [], "sc").length).toBeGreaterThan(0);
	});

	it("puts exact, then prefix, then word-start, then mid-word matches first", () => {
		expect(rankSuggestions(TAGS, [], "science fiction")).toEqual([
			"Science Fiction",
			"Fiction - Science Fiction",
			"American Science Fiction And Fantasy",
			"Fiction / Science Fiction / Space Opera",
		]);
		expect(rankSuggestions(TAGS, [], "science")).toEqual([
			"Science",
			"Science Fiction",
			"Fiction - Science Fiction",
			"American Science Fiction And Fantasy",
			"Fiction / Science Fiction / Space Opera",
			"Conscience",
		]);
	});

	it("leaves out values already chosen, whatever their case", () => {
		expect(rankSuggestions(TAGS, ["science fiction"], "science fic")).toEqual([
			"Fiction - Science Fiction",
			"American Science Fiction And Fantasy",
			"Fiction / Science Fiction / Space Opera",
		]);
	});
});

describe("exactMatchIndex", () => {
	it("pre-selects only a suggestion that is exactly what was typed", () => {
		const ranked = rankSuggestions(TAGS, [], "science fiction");
		expect(exactMatchIndex(ranked, "Science fiction ")).toBe(0);
		expect(exactMatchIndex(rankSuggestions(TAGS, [], "scien"), "scien")).toBe(
			-1,
		);
	});
});
