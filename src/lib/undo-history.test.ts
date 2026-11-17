import { describe, expect, it, vi } from "vitest";
import { unwrap } from "@/lib/option";
import {
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
