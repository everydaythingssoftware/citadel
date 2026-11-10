import { describe, expect, it } from "vitest";
import type { LibraryPath } from "@/lib/platform/settings/types";
import {
	entryIds,
	type LeavingLibrary,
	type LibraryListEntry,
	withLeavingLibraries,
} from "./leaving-libraries";

const library = (id: string): LibraryPath => ({
	id,
	displayName: id.toUpperCase(),
	absolutePath: `/Books/${id}`,
});
const ALL = ["a", "b", "c", "d", "e"];

/** Forgets `ids` in quick succession, before any row has finished leaving. */
const forgetInTurn = (ids: string[]) => {
	let libraries = ALL.map(library);
	const leaving: LeavingLibrary[] = [];
	for (const id of ids) {
		leaving.push({
			library: library(id),
			before: entryIds(withLeavingLibraries(libraries, leaving)),
		});
		libraries = libraries.filter((other) => other.id !== id);
	}
	return { libraries, leaving };
};

const describeRows = (entries: LibraryListEntry[]) =>
	entries.map((entry) =>
		entry.kind === "library" ? entry.library.id : `-${entry.library.id}`,
	);

describe("withLeavingLibraries", () => {
	it.each([
		["the top twice", ["a", "b"], ["-a", "-b", "c", "d", "e"]],
		["the bottom twice", ["e", "d"], ["a", "b", "c", "-d", "-e"]],
		["the middle", ["c"], ["a", "b", "-c", "d", "e"]],
		["rows that aren't neighbours", ["b", "d"], ["a", "-b", "c", "-d", "e"]],
		[
			"the same rows the other way round",
			["d", "b"],
			["a", "-b", "c", "-d", "e"],
		],
		["all but one", ["a", "c", "e", "b"], ["-a", "-b", "-c", "d", "-e"]],
	])("keeps each leaving row in place when forgetting %s", (_, ids, rows) => {
		const { libraries, leaving } = forgetInTurn(ids);
		expect(describeRows(withLeavingLibraries(libraries, leaving))).toEqual(
			rows,
		);
	});

	it("shows a library still in the list as itself, not twice", () => {
		const { leaving } = forgetInTurn(["b"]);
		expect(
			describeRows(withLeavingLibraries(ALL.map(library), leaving)),
		).toEqual(ALL);
	});
});
