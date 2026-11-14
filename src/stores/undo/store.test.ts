import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUndoHistory, redoTitle, undoTitle } from "@/lib/undo-history";
import {
	clearUndoHistory,
	redoLast,
	registerUndo,
	undoLast,
	useUndoStore,
} from "./store";

const history = () => useUndoStore.getState().history;

describe("undo store", () => {
	beforeEach(() =>
		useUndoStore.setState({ history: emptyUndoHistory, running: false }),
	);

	it("undoes and redoes the registered action", async () => {
		const undo = vi.fn(async () => {});
		const redo = vi.fn(async () => {});
		registerUndo({ name: "Mark as Finished", undo, redo });
		await undoLast();
		expect(undo).toHaveBeenCalledOnce();
		expect(redoTitle(history())).toBe("Redo Mark as Finished");
		await redoLast();
		expect(redo).toHaveBeenCalledOnce();
		expect(undoTitle(history())).toBe("Undo Mark as Finished");
	});

	it("does nothing when there is nothing to undo", async () => {
		await expect(undoLast()).resolves.toBeUndefined();
		await expect(redoLast()).resolves.toBeUndefined();
	});

	it("forgets everything when an action can't be undone", () => {
		registerUndo({
			name: "Mark as Finished",
			undo: async () => {},
			redo: async () => {},
		});
		clearUndoHistory();
		expect(undoTitle(history())).toBeNull();
	});

	it("runs one step at a time", async () => {
		let finish: () => void = () => {};
		const undo = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		registerUndo({ name: "A", undo, redo: async () => {} });
		registerUndo({ name: "B", undo, redo: async () => {} });
		const first = undoLast();
		await undoLast();
		expect(undo).toHaveBeenCalledOnce();
		finish();
		await first;
		expect(undoTitle(history())).toBe("Undo A");
	});

	it("drops the history when an undo fails halfway", async () => {
		registerUndo({ name: "A", undo: async () => {}, redo: async () => {} });
		registerUndo({
			name: "B",
			undo: async () => {
				throw new Error("disk full");
			},
			redo: async () => {},
		});
		await expect(undoLast()).rejects.toThrow("disk full");
		expect(history()).toBe(emptyUndoHistory);
	});
});
