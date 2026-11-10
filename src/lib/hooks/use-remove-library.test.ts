import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/library-catalog", () => ({ libraryCatalog: {} }));

import { successorsOf } from "./use-remove-library";

const library = (id: string) => ({
	id,
	displayName: id,
	absolutePath: `/Books/${id}`,
});
const LIBRARIES = ["a", "b", "c", "d"].map(library);
const ids = (libraries: { id: string }[]) => libraries.map(({ id }) => id);

describe("successorsOf", () => {
	it("tries the next library, then the earlier ones nearest first", () => {
		expect(ids(successorsOf(LIBRARIES, "b"))).toEqual(["c", "d", "a"]);
		expect(ids(successorsOf(LIBRARIES, "d"))).toEqual(["c", "b", "a"]);
	});

	it("has nowhere to go from the only library", () => {
		expect(successorsOf([library("a")], "a")).toEqual([]);
	});
});
