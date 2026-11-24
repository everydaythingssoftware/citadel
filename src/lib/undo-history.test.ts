import { describe, expect, it, vi } from "vitest";
import type { BookEdit, EditBooksOutcome } from "@/bindings";
import { unwrap } from "@/lib/option";
import {
	editBooksEntry,
	emptyUndoHistory,
	finishedEntry,
	redoStep,
	redoTitle,
	registerEntry,
	UNDO_LIMIT,
	type UndoEntry,
	undoStep,
	undoTitle,
} from "./undo-history";

const entry = (name: string): UndoEntry => ({
	name,
	undo: async () => {},
	redo: async () => {},
});

describe("undo history", () => {
	it("names nothing, so Undo and Redo are disabled, when empty", () => {
		expect(undoTitle(emptyUndoHistory)).toBeNull();
		expect(redoTitle(emptyUndoHistory)).toBeNull();
		expect(undoStep(emptyUndoHistory).isSome).toBe(false);
		expect(redoStep(emptyUndoHistory).isSome).toBe(false);
	});

	it("names the top entry", () => {
		const history = registerEntry(
			registerEntry(emptyUndoHistory, entry("Mark as Unfinished")),
			entry("Mark as Finished"),
		);
		expect(undoTitle(history)).toBe("Undo Mark as Finished");
		expect(redoTitle(history)).toBeNull();
	});

	it("moves an undone entry to Redo and back", () => {
		const marked = registerEntry(emptyUndoHistory, entry("Mark as Finished"));
		const undone = unwrap(undoStep(marked));
		expect(undone.entry.name).toBe("Mark as Finished");
		expect(undoTitle(undone.history)).toBeNull();
		expect(redoTitle(undone.history)).toBe("Redo Mark as Finished");
		const redone = unwrap(redoStep(undone.history));
		expect(undoTitle(redone.history)).toBe("Undo Mark as Finished");
		expect(redoTitle(redone.history)).toBeNull();
	});

	it("drops Redo when a new action is registered", () => {
		const undone = unwrap(
			undoStep(registerEntry(emptyUndoHistory, entry("Mark as Finished"))),
		);
		const next = registerEntry(undone.history, entry("Mark as Unfinished"));
		expect(redoTitle(next)).toBeNull();
		expect(undoTitle(next)).toBe("Undo Mark as Unfinished");
	});

	it(`keeps the last ${UNDO_LIMIT} steps`, () => {
		let history = emptyUndoHistory;
		for (let step = 0; step < UNDO_LIMIT + 5; step++)
			history = registerEntry(history, entry(`Step ${step}`));
		expect(history.undo).toHaveLength(UNDO_LIMIT);
		expect(history.undo[0]?.name).toBe("Step 5");
	});
});

describe("finishedEntry", () => {
	it("flips the books back on Undo, and sets them again on Redo", async () => {
		const apply = vi.fn(
			async (_ids: readonly string[], _finished: boolean) => {},
		);
		const marked = finishedEntry(["a", "b"], true, apply);
		expect(marked.name).toBe("Mark as Finished");
		await marked.undo();
		expect(apply.mock.calls).toEqual([[["a", "b"], false]]);
		apply.mockClear();
		await marked.redo();
		expect(apply.mock.calls).toEqual([[["a", "b"], true]]);
	});

	it("names the unfinishing", () => {
		expect(finishedEntry([], false, async () => {}).name).toBe(
			"Mark as Unfinished",
		);
	});
});

describe("editBooksEntry", () => {
	const forward: BookEdit[] = [
		{ book_id: "1", add_tags: ["new"] },
		{ book_id: "2", add_tags: ["new"] },
		{ book_id: "3", add_tags: ["new"] },
	];
	const undoEdits: BookEdit[] = [
		{ book_id: "1", remove_tags: ["new"] },
		{ book_id: "2", remove_tags: ["new"] },
		{ book_id: "3", remove_tags: ["new"] },
	];

	it("names the books that the server changed", () => {
		const editEntry = editBooksEntry(
			forward,
			undoEdits.slice(0, 2),
			async () => ({ undo: [] }),
			() => {},
		);
		expect(editEntry.name).toBe("Edit 2 Books");
	});

	it("names one changed book in the singular", () => {
		const editEntry = editBooksEntry(
			forward,
			undoEdits.slice(0, 1),
			async () => ({ undo: [] }),
			() => {},
		);
		expect(editEntry.name).toBe("Edit Book");
	});

	it("undoes with the undo edits and redoes with the forward edits", async () => {
		const apply = vi.fn(
			async (_edits: readonly BookEdit[]): Promise<EditBooksOutcome> => ({
				undo: undoEdits,
			}),
		);
		const onFailure = vi.fn();
		const editEntry = editBooksEntry(forward, undoEdits, apply, onFailure);
		await editEntry.undo();
		expect(apply.mock.calls).toEqual([[undoEdits]]);
		apply.mockClear();
		await editEntry.redo();
		expect(apply.mock.calls).toEqual([[forward]]);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("undoes with the undo edits that the last Redo returned", async () => {
		const redoUndo: BookEdit[] = [
			{ book_id: "1", series: "Dune", remove_tags: ["new"] },
		];
		const apply = vi.fn(
			async (_edits: readonly BookEdit[]): Promise<EditBooksOutcome> => ({
				undo: redoUndo,
			}),
		);
		const editEntry = editBooksEntry(forward, undoEdits, apply, vi.fn());
		await editEntry.undo();
		await editEntry.redo();
		apply.mockClear();
		await editEntry.undo();
		expect(apply.mock.calls).toEqual([[redoUndo]]);
		expect(editEntry.name).toBe("Edit 3 Books");
	});

	it.each([
		"undo",
		"redo",
	] as const)("reports a failed %s and throws the same error again", async (direction) => {
		const failure = new Error("gone");
		const apply = vi.fn(
			async (_edits: readonly BookEdit[]): Promise<EditBooksOutcome> => ({
				undo: undoEdits,
			}),
		);
		apply.mockRejectedValueOnce(failure);
		const onFailure = vi.fn();
		const editEntry = editBooksEntry(forward, undoEdits, apply, onFailure);
		const thrown = await editEntry[direction]().catch(
			(error: unknown) => error,
		);
		expect(thrown).toBe(failure);
		expect(onFailure).toHaveBeenCalledOnce();
		expect(onFailure.mock.calls[0]?.[0]).toBe(direction);
		expect(onFailure.mock.calls[0]?.[1]).toBe(failure);
		expect(apply).toHaveBeenCalledOnce();
	});
});
