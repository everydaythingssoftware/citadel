import { describe, expect, it, vi } from "vitest";
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
		expect(undoStep(emptyUndoHistory)).toBeNull();
		expect(redoStep(emptyUndoHistory)).toBeNull();
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
		const undone = undoStep(marked);
		expect(undone?.entry.name).toBe("Mark as Finished");
		expect(undoTitle(undone?.history ?? marked)).toBeNull();
		expect(redoTitle(undone?.history ?? marked)).toBe("Redo Mark as Finished");
		const redone = redoStep(undone?.history ?? marked);
		expect(undoTitle(redone?.history ?? marked)).toBe("Undo Mark as Finished");
		expect(redoTitle(redone?.history ?? marked)).toBeNull();
	});

	it("drops Redo when a new action is registered", () => {
		const undone = undoStep(
			registerEntry(emptyUndoHistory, entry("Mark as Finished")),
		);
		const next = registerEntry(
			undone?.history ?? emptyUndoHistory,
			entry("Mark as Unfinished"),
		);
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
	it("puts each book back as it was, and sets them all again on Redo", async () => {
		const apply = vi.fn(async () => {});
		const changes = [
			{ id: "a", wasFinished: false },
			{ id: "b", wasFinished: false },
		];
		const marked = finishedEntry(changes, true, apply);
		expect(marked.name).toBe("Mark as Finished");
		await marked.undo();
		expect(apply.mock.calls).toEqual([
			["a", false],
			["b", false],
		]);
		apply.mockClear();
		await marked.redo();
		expect(apply.mock.calls).toEqual([
			["a", true],
			["b", true],
		]);
	});

	it("names the unfinishing", () => {
		expect(finishedEntry([], false, async () => {}).name).toBe(
			"Mark as Unfinished",
		);
	});
});
