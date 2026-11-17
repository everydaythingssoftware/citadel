import { describe, expect, it } from "vitest";
import { appUndo, isBookCommand } from "./menu-commands";
import { none, some } from "./option";
import { emptyUndoHistory, registerEntry } from "./undo-history";

describe("isBookCommand", () => {
	it("sends the Book menu to the selection's actions", () => {
		expect(isBookCommand("book-show-details")).toBe(true);
		expect(isBookCommand("book-mark-finished")).toBe(true);
		expect(isBookCommand("find")).toBe(false);
		expect(isBookCommand({ go: "allBooks" })).toBe(false);
	});
});

describe("appUndo", () => {
	const history = registerEntry(emptyUndoHistory, {
		name: "Mark as Finished",
		undo: async () => {},
		redo: async () => {},
	});

	it("names the app's history while the editor is closed", () => {
		expect(appUndo(none(), history)).toEqual({
			undoLabel: "Undo Mark as Finished",
			redoLabel: null,
		});
		expect(appUndo(none(), emptyUndoHistory)).toEqual({
			undoLabel: null,
			redoLabel: null,
		});
	});

	it("is the editor's own Undo, and no Redo, while it is open", () => {
		expect(appUndo(some({ undo: some(() => {}) }), history)).toEqual({
			undoLabel: "Undo Edit",
			redoLabel: null,
		});
		expect(appUndo(some({ undo: none() }), history)).toEqual({
			undoLabel: null,
			redoLabel: null,
		});
	});
});
