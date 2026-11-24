import { describe, expect, it } from "vitest";
import { exactMatchIndex, matchingToken, rankSuggestions } from "./suggestions";

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

	it("leaves out values already chosen, whatever their ASCII case", () => {
		expect(rankSuggestions(TAGS, ["science fiction"], "science fic")).toEqual([
			"Fiction - Science Fiction",
			"American Science Fiction And Fantasy",
			"Fiction / Science Fiction / Space Opera",
		]);
	});

	it("ignores only ASCII case for a chosen value and an exact match, as SQLite NOCASE does", () => {
		expect(
			rankSuggestions(["ästhetik", "Ästhetik"], ["Ästhetik"], "ästhetik"),
		).toEqual(["ästhetik"]);
		expect(rankSuggestions(["ästhetik", "Ästhetik"], [], "Ästhetik")).toEqual([
			"Ästhetik",
			"ästhetik",
		]);
	});

	it("finds a value with letters that are not ASCII, whatever their case", () => {
		expect(rankSuggestions(["Ästhetik", "Фантастика"], [], "äS")).toEqual([
			"Ästhetik",
		]);
		expect(rankSuggestions(["Ästhetik", "Фантастика"], [], "фант")).toEqual([
			"Фантастика",
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

	it("ignores only ASCII case, as SQLite NOCASE does", () => {
		expect(exactMatchIndex(["Ästhetik"], "ästhetik")).toBe(-1);
		expect(exactMatchIndex(["Ästhetik"], "ÄSTHETIK")).toBe(0);
	});
});

describe("matchingToken", () => {
	it("finds the token with its own spelling, ignoring case and spaces", () => {
		expect(matchingToken(["Epic", "Fantasy"], " epic ")).toBe("Epic");
	});
	it("finds the first of two tokens that differ only in case", () => {
		expect(matchingToken(["Epic", "EPIC"], "epic")).toBe("Epic");
		expect(matchingToken(["EPIC", "Epic"], "Epic")).toBe("EPIC");
	});
	it("ignores only ASCII case, as SQLite NOCASE does", () => {
		expect(matchingToken(["Ästhetik"], "ästhetik")).toBeUndefined();
		expect(matchingToken(["Ästhetik"], "ÄSTHETIK")).toBe("Ästhetik");
	});
	it("finds nothing for a new name or blank text", () => {
		expect(matchingToken(["Epic"], "New")).toBeUndefined();
		expect(matchingToken(["Epic"], "  ")).toBeUndefined();
	});
});
