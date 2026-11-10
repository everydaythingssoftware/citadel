import { describe, expect, it } from "vitest";
import type { LibraryPath } from "@/lib/platform/settings/types";
import {
	entryIds,
	type LibraryListEntry,
	type PendingRemoval,
	withPendingRemovals,
} from "./pending-removals";

const library = (id: string): LibraryPath => ({
	id,
	displayName: id.toUpperCase(),
	absolutePath: `/Books/${id}`,
});
const ALL = ["a", "b", "c", "d", "e"];

/** Removes `ids` one after another, as a person would, and lists the rows. */
const removeInTurn = (ids: string[]) => {
	let libraries = ALL.map(library);
	const pending: PendingRemoval[] = [];
	for (const id of ids) {
		pending.push({
			library: library(id),
			before: entryIds(withPendingRemovals(libraries, pending)),
			wasActive: false,
			phase: "placeholder",
			error: null,
		});
		libraries = libraries.filter((other) => other.id !== id);
	}
	return { libraries, pending };
};

const describeRows = (entries: LibraryListEntry[]) =>
	entries.map((entry) =>
		entry.kind === "library"
			? entry.library.id
			: `-${entry.removal.library.id}`,
	);

describe("withPendingRemovals", () => {
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
	])("keeps each placeholder in place when removing %s", (_, ids, rows) => {
		const { libraries, pending } = removeInTurn(ids);
		expect(describeRows(withPendingRemovals(libraries, pending))).toEqual(rows);
	});

	it("places a removal after an earlier placeholder has closed", () => {
		const { libraries } = removeInTurn(["a"]);
		const { pending } = (() => {
			const removal: PendingRemoval = {
				library: library("b"),
				before: entryIds(withPendingRemovals(libraries, [])),
				wasActive: false,
				phase: "placeholder",
				error: null,
			};
			return { pending: [removal] };
		})();
		const remaining = libraries.filter((entry) => entry.id !== "b");
		expect(describeRows(withPendingRemovals(remaining, pending))).toEqual([
			"-b",
			"c",
			"d",
			"e",
		]);
	});

	it("shows a restored library as itself, not twice", () => {
		const { pending } = removeInTurn(["b"]);
		const restored = ALL.map(library);
		expect(describeRows(withPendingRemovals(restored, pending))).toEqual(ALL);
	});

	it("undoing one of several leaves the others in place", () => {
		const { libraries, pending } = removeInTurn(["a", "b", "d"]);
		const afterUndoingA = [library("a"), ...libraries];
		expect(
			describeRows(
				withPendingRemovals(
					afterUndoingA,
					pending.filter((removal) => removal.library.id !== "a"),
				),
			),
		).toEqual(["a", "-b", "c", "-d", "e"]);
	});
});
