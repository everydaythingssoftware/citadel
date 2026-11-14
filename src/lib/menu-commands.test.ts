import { describe, expect, it } from "vitest";
import { BOOK_COMMAND } from "./book-menu";
import {
	EDITOR_UNDO_TITLE,
	GO_DESTINATIONS,
	type MenuStateInput,
	menuAction,
	menuStateFor,
	menuStatePatch,
	needsSelection,
	undoTitles,
} from "./menu-commands";

describe("menuAction", () => {
	it("sends the Book menu to the selection's actions", () => {
		expect(menuAction("book-show-details")).toEqual({
			type: "book",
			command: BOOK_COMMAND.showDetails,
		});
		expect(menuAction("book-mark-finished")).toEqual({
			type: "book",
			command: BOOK_COMMAND.toggleFinished,
		});
		expect(menuAction("book-delete")).toEqual({
			type: "book",
			command: BOOK_COMMAND.delete,
		});
		expect(needsSelection(menuAction("book-open"))).toBe(true);
		expect(needsSelection(menuAction("find"))).toBe(false);
	});

	it("maps sort items to the view's sort orders", () => {
		expect(menuAction("sort-name-az")).toEqual({
			type: "sort",
			order: "nameAz",
		});
		expect(menuAction("sort-author-za")).toEqual({
			type: "sort",
			order: "authorZa",
		});
	});

	it("goes to each destination, resetting only for All Books", () => {
		expect(menuAction("go-all-books")).toEqual({
			type: "go",
			path: "/",
			resetToAllBooks: true,
		});
		expect(menuAction("go-publishers")).toEqual({
			type: "go",
			path: "/publishers",
			resetToAllBooks: false,
		});
		expect(GO_DESTINATIONS.map((destination) => destination.title)).toEqual([
			"All Books",
			"Authors",
			"Series",
			"Tags",
			"Publishers",
		]);
	});

	it("walks history for Back and Forward", () => {
		expect(menuAction("go-back")).toEqual({
			type: "history",
			direction: "back",
		});
		expect(menuAction("go-forward")).toEqual({
			type: "history",
			direction: "forward",
		});
	});

	it("carries the library id of a switch", () => {
		expect(menuAction({ switchLibrary: "a:b" })).toEqual({
			type: "switch-library",
			libraryId: "a:b",
		});
	});

	it("maps the remaining commands one to one", () => {
		expect(menuAction("find").type).toBe("find");
		expect(menuAction("toggle-sidebar").type).toBe("toggle-sidebar");
		expect(menuAction("toggle-unread-only").type).toBe("toggle-unread-only");
		expect(menuAction("new-shelf").type).toBe("new-shelf");
		expect(menuAction("add-library").type).toBe("add-library");
		expect(menuAction("show-library-in-file-manager").type).toBe(
			"show-library-in-file-manager",
		);
		expect(menuAction("undo")).toEqual({ type: "edit", command: "undo" });
		expect(menuAction("redo")).toEqual({ type: "edit", command: "redo" });
		expect(menuAction("select-all").type).toBe("select-all");
		expect(menuAction("add-book").type).toBe("add-book");
		expect(menuAction("open-settings").type).toBe("open-settings");
		expect(menuAction("restart-to-update").type).toBe("none");
	});
});

const input: MenuStateInput = {
	selectedBookCount: 2,
	selectionAllFinished: false,
	keyboardBusy: false,
	sidebarVisible: true,
	unreadOnly: false,
	sortOrder: "authorAz",
	libraries: [
		{ id: "a", displayName: "Fiction" },
		{ id: "b", displayName: "Papers" },
	],
	activeLibraryId: "b",
	windowActive: true,
	undo: { undo: null, redo: null },
};

describe("menuStateFor", () => {
	it("names the libraries and checks the open one", () => {
		expect(menuStateFor(input).libraries).toEqual([
			{ id: "a", name: "Fiction", active: false },
			{ id: "b", name: "Papers", active: true },
		]);
	});

	it("stands the Book menu down while the keyboard is busy", () => {
		expect(menuStateFor(input).selectedBookCount).toBe(2);
		expect(
			menuStateFor({ ...input, keyboardBusy: true }).selectedBookCount,
		).toBe(0);
	});

	it("names Undo after the top entry, and keeps the text field's own Undo while one is focused", () => {
		const marked = {
			...input,
			undo: { undo: "Undo Mark as Finished", redo: null },
		};
		expect(menuStateFor(marked)).toMatchObject({
			appUndo: true,
			undoLabel: "Undo Mark as Finished",
			redoLabel: null,
		});
		expect(menuStateFor({ ...marked, keyboardBusy: true }).appUndo).toBe(false);
	});

	it("leaves Undo native while another window is in front", () => {
		expect(menuStateFor({ ...input, windowActive: false }).appUndo).toBe(false);
	});

	it("offers a disabled Undo when there is nothing to undo", () => {
		expect(menuStateFor(input)).toMatchObject({
			appUndo: true,
			undoLabel: null,
			redoLabel: null,
		});
	});
});

describe("undoTitles", () => {
	const history = {
		undo: "Undo Mark as Finished",
		redo: "Redo Mark as Finished",
	};

	it("is the app's history while the editor is closed", () => {
		expect(
			undoTitles({ editor: { open: false, canUndo: false }, history }),
		).toEqual(history);
	});

	it("is the editor's own Undo, and no Redo, while it is open", () => {
		expect(
			undoTitles({ editor: { open: true, canUndo: true }, history }),
		).toEqual({ undo: EDITOR_UNDO_TITLE, redo: null });
		expect(
			undoTitles({ editor: { open: true, canUndo: false }, history }),
		).toEqual({ undo: null, redo: null });
	});
});

describe("menuStatePatch", () => {
	it("pushes everything the first time", () => {
		const state = menuStateFor(input);
		expect(menuStatePatch(null, state)).toEqual(state);
	});

	it("pushes nothing when nothing changed", () => {
		const state = menuStateFor(input);
		expect(menuStatePatch(state, menuStateFor({ ...input }))).toBeNull();
	});

	it("pushes only the fields that changed", () => {
		const before = menuStateFor(input);
		const after = menuStateFor({
			...input,
			selectedBookCount: 1,
			activeLibraryId: "a",
		});
		expect(menuStatePatch(before, after)).toEqual({
			selectedBookCount: 1,
			libraries: after.libraries,
		});
	});
});
