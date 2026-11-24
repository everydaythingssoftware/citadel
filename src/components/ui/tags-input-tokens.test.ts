import { describe, expect, it } from "vitest";
import { tokenCommit, tokenRemoveLabel, tokenText } from "./tags-input-tokens";

describe("tokenRemoveLabel", () => {
	it("gives Remove and the token without a removeLabel", () => {
		expect(tokenRemoveLabel("Epic", undefined)).toBe("Remove Epic");
	});

	it("gives the label of removeLabel", () => {
		expect(
			tokenRemoveLabel("Epic", (token) => `Remove ${token} from 3 books`),
		).toBe("Remove Epic from 3 books");
	});
});

describe("tokenText", () => {
	it("gives the name and the detail of a token", () => {
		expect(tokenText("Epic", () => "3 of 5")).toEqual({
			name: "Epic",
			detail: "3 of 5",
		});
	});

	it("gives no detail without a tokenDetail, or for an empty detail", () => {
		expect(tokenText("Epic", undefined)).toEqual({
			name: "Epic",
			detail: undefined,
		});
		expect(tokenText("Epic", () => undefined).detail).toBeUndefined();
		expect(tokenText("Epic", () => "").detail).toBeUndefined();
	});
});

describe("tokenCommit", () => {
	it("commits nothing for blank text", () => {
		expect(tokenCommit(["Epic"], [], "  ")).toEqual({ kind: "none" });
	});

	it("commits an existing token with its own spelling", () => {
		expect(tokenCommit(["Epic"], ["EPIC"], " epic ")).toEqual({
			kind: "existing",
			token: "Epic",
		});
	});

	it("adds a new token with the spelling of a suggestion", () => {
		expect(
			tokenCommit(["Epic"], ["Science Fiction"], "science fiction"),
		).toEqual({ kind: "new", token: "Science Fiction" });
	});

	it("adds a new token with the trimmed text when no suggestion matches", () => {
		expect(tokenCommit([], ["Epic"], " Horror ")).toEqual({
			kind: "new",
			token: "Horror",
		});
	});
});
