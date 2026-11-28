import { describe, expect, it } from "vitest";
import type { LibrarySearchHint } from "@/bindings";
import {
	type BookGridFacts,
	bookGridView,
	failedOutcome,
	loadedOutcome,
	outcomeFor,
} from "./book-grid-view";
import { InvalidSearchError } from "./services/library/types";

const hint = (name: string): LibrarySearchHint => ({
	kind: "unknownField",
	name,
	message: `No field named "${name}". Searched as text.`,
});

/** The facts of a ready library whose current filter `k` has no result yet. */
const facts = (overrides: Partial<BookGridFacts> = {}): BookGridFacts => ({
	libraryReady: true,
	cache: { key: "k", total: null },
	staleSnapshot: null,
	pageOutcome: null,
	libraryTotal: 10,
	selectedCount: 0,
	...overrides,
});

/** The cache of the filter `k` after its first page gave `total` books. */
const resolved = (total: number): Pick<BookGridFacts, "cache"> => ({
	cache: { key: "k", total },
});

/** The request for page `pageIndex` of the filter `key`. */
const request = (key = "k", pageIndex = 0) => ({ key, pageIndex });

const searchError = (key = "k") =>
	failedOutcome(
		null,
		request(key),
		new InvalidSearchError("Missing closing quote."),
	);
const loadError = (key = "k") =>
	failedOutcome(null, request(key), new Error("Library unavailable"));

describe("page outcome", () => {
	it("keeps the key and the hint messages of a loaded page", () => {
		expect(loadedOutcome(null, request(), [hint("a"), hint("b")])).toEqual({
			key: "k",
			kind: "ok",
			hints: [
				'No field named "a". Searched as text.',
				'No field named "b". Searched as text.',
			],
		});
	});

	it("tells a search error from a load error", () => {
		expect(searchError()).toEqual({
			key: "k",
			kind: "searchError",
			message: "Missing closing quote.",
		});
		expect(loadError()).toEqual({
			key: "k",
			kind: "loadError",
			message: "Library unavailable",
			hints: [],
			failedPages: [0],
		});
		expect(failedOutcome(null, request(), "boom")).toEqual({
			key: "k",
			kind: "loadError",
			message: "Failed to load books",
			hints: [],
			failedPages: [0],
		});
	});

	it("keeps a load error until each failed page of its key loads", () => {
		const failed = failedOutcome(
			failedOutcome(null, request("k", 0), new Error("Busy")),
			request("k", 2),
			new Error("Busy"),
		);
		const afterOtherPage = loadedOutcome(failed, request("k", 1), []);
		expect(afterOtherPage).toMatchObject({
			kind: "loadError",
			failedPages: [0, 2],
		});
		const afterFirstPage = loadedOutcome(afterOtherPage, request("k", 0), []);
		expect(afterFirstPage).toMatchObject({
			kind: "loadError",
			failedPages: [2],
		});
		expect(loadedOutcome(afterFirstPage, request("k", 2), [])).toEqual(
			loadedOutcome(null, request("k", 2), []),
		);
	});

	it("starts again for another key", () => {
		const failed = failedOutcome(null, request("old", 0), new Error("Busy"));
		expect(loadedOutcome(failed, request("k", 1), [])).toEqual(
			loadedOutcome(null, request("k", 1), []),
		);
		expect(
			failedOutcome(failed, request("k", 1), new Error("Busy")),
		).toMatchObject({ failedPages: [1] });
	});

	it("answers only for its own key", () => {
		const error = loadError();
		expect(outcomeFor(error, "k")).toBe(error);
		expect(outcomeFor(error, "other")).toBeNull();
		expect(outcomeFor(null, "k")).toBeNull();
	});
});

describe("grid status", () => {
	const status = (overrides: Partial<BookGridFacts>) =>
		bookGridView(facts(overrides)).status;

	it("loads until the library is ready", () => {
		expect(status({ libraryReady: false })).toBe("loading");
		expect(status({ libraryReady: false, ...resolved(3) })).toBe("loading");
	});

	it("loads while the first query has no result and no snapshot", () => {
		expect(status({})).toBe("loading");
	});

	it("dims the last results while a new query is in flight", () => {
		expect(status({ staleSnapshot: { total: 5 } })).toBe("searching");
	});

	it("keeps the last results, not dimmed, when the query failed", () => {
		expect(
			status({ staleSnapshot: { total: 5 }, pageOutcome: searchError() }),
		).toBe("stale");
	});

	it("shows nothing when the query failed with no earlier results", () => {
		expect(status({ pageOutcome: searchError() })).toBe("failed");
		expect(status({ pageOutcome: loadError() })).toBe("failed");
	});

	it("does not dim the last results while the callout shows a search error", () => {
		expect(
			status({ staleSnapshot: { total: 5 }, pageOutcome: searchError("old") }),
		).toBe("stale");
	});

	it("ignores the failure of another filter", () => {
		expect(status({ pageOutcome: searchError("old") })).toBe("loading");
		expect(
			status({ staleSnapshot: { total: 5 }, pageOutcome: loadError("old") }),
		).toBe("searching");
	});

	it("is ready once the query resolved", () => {
		expect(status(resolved(3))).toBe("ready");
		expect(status({ ...resolved(3), staleSnapshot: { total: 5 } })).toBe(
			"ready",
		);
	});
});

describe("grid total", () => {
	it("counts the current filter, or the last results while it loads", () => {
		expect(bookGridView(facts(resolved(3))).total).toBe(3);
		expect(bookGridView(facts({ staleSnapshot: { total: 5 } })).total).toBe(5);
		expect(bookGridView(facts()).total).toBe(0);
	});
});

describe("search callout", () => {
	const callout = (pageOutcome: BookGridFacts["pageOutcome"]) =>
		bookGridView(facts({ pageOutcome })).callout;

	it("shows all hints of the last page", () => {
		expect(callout(loadedOutcome(null, request(), []))).toBeNull();
		expect(
			callout(loadedOutcome(null, request(), [hint("a"), hint("b")])),
		).toEqual({
			tone: "hint",
			text: 'No field named "a". Searched as text. No field named "b". Searched as text.',
		});
	});

	it("shows a search error, and not a load error", () => {
		expect(callout(searchError())).toEqual({
			tone: "error",
			text: "Missing closing quote.",
		});
		expect(callout(loadError())).toBeNull();
		expect(callout(null)).toBeNull();
	});

	it("keeps the hints of the text after a load error of a later page", () => {
		const loaded = loadedOutcome(null, request("k", 0), [hint("titel")]);
		expect(
			callout(failedOutcome(loaded, request("k", 3), new Error("Busy"))),
		).toEqual({
			tone: "hint",
			text: 'No field named "titel". Searched as text.',
		});
	});

	it("keeps the last answer while the next filter loads", () => {
		expect(callout(searchError("old"))).toEqual({
			tone: "error",
			text: "Missing closing quote.",
		});
	});
});

describe("status bar", () => {
	const footer = (overrides: Partial<BookGridFacts>) =>
		bookGridView(facts(overrides)).footer;

	it("counts the books of the resolved filter", () => {
		expect(footer({ ...resolved(1), libraryTotal: 1 })).toBe("1 book");
		expect(footer({ ...resolved(1), libraryTotal: 1204 })).toBe(
			"1 of 1,204 books",
		);
	});

	it("says it is loading", () => {
		expect(footer({})).toBe("Loading books…");
		expect(footer({ libraryReady: false, ...resolved(1) })).toBe(
			"Loading books…",
		);
	});

	it("gives the reason when the books did not load", () => {
		expect(footer({ pageOutcome: loadError() })).toBe(
			"Could not load books: Library unavailable",
		);
		expect(
			footer({ staleSnapshot: { total: 5 }, pageOutcome: loadError() }),
		).toBe("Could not load books: Library unavailable");
	});

	it("is empty when the search failed and no results exist", () => {
		expect(footer({ pageOutcome: searchError() })).toBe("");
	});

	it("ignores the load error of another filter", () => {
		expect(
			footer({
				...resolved(1),
				libraryTotal: 1,
				pageOutcome: loadError("old"),
			}),
		).toBe("1 book");
	});
});

describe("empty library", () => {
	const emptyLibrary = (overrides: Partial<BookGridFacts>) =>
		bookGridView(facts(overrides)).emptyLibrary;

	it("is false for a failed search while the library total is unknown", () => {
		expect(
			emptyLibrary({ pageOutcome: searchError(), libraryTotal: null }),
		).toBe(false);
	});

	it("is true for a failed search when the library has 0 books", () => {
		expect(emptyLibrary({ pageOutcome: searchError(), libraryTotal: 0 })).toBe(
			true,
		);
	});

	it("is false for books on screen while the library total is unknown", () => {
		expect(emptyLibrary({ ...resolved(5), libraryTotal: null })).toBe(false);
		expect(
			emptyLibrary({ staleSnapshot: { total: 5 }, libraryTotal: null }),
		).toBe(false);
	});

	it("keeps the current rule when the search has no error", () => {
		expect(emptyLibrary({ ...resolved(0), libraryTotal: null })).toBe(true);
		expect(emptyLibrary({ ...resolved(0), libraryTotal: 0 })).toBe(true);
		expect(emptyLibrary({ ...resolved(5), libraryTotal: 5 })).toBe(false);
		expect(emptyLibrary({ libraryTotal: 0 })).toBe(false);
	});
});

describe("no matches", () => {
	const noMatches = (overrides: Partial<BookGridFacts>) =>
		bookGridView(facts(overrides)).noMatches;

	it("is true when the resolved filter finds no book in a library with books", () => {
		expect(noMatches(resolved(0))).toBe(true);
	});

	it("is false in an empty library, with matches, or before the result", () => {
		expect(noMatches({ ...resolved(0), libraryTotal: 0 })).toBe(false);
		expect(noMatches(resolved(2))).toBe(false);
		expect(noMatches({ staleSnapshot: { total: 0 } })).toBe(false);
		expect(noMatches({ pageOutcome: searchError() })).toBe(false);
	});
});
