import { describe, expect, it } from "vitest";
import { appUndo, isBookCommand, selectAllOwner } from "./menu-commands";
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

describe("selectAllOwner", () => {
	it("gives Select All to the books only on the Books page, outside fields and sheets", () => {
		expect(selectAllOwner(false, "/")).toBe("books");
		expect(selectAllOwner(true, "/")).toBe("native");
		expect(selectAllOwner(false, "/authors")).toBe("native");
	});
});
