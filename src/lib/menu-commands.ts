import type { TAppCommand, TShortcutCommand } from "@/lib/app-shortcuts";
import { BOOK_COMMAND, type TBookCommand } from "@/lib/book-menu";
import type { MenuCommand, MenuState } from "@/lib/platform/types";
import type { LibraryBookSortOrderKey } from "@/stores/library-view/store";

/** A Go destination, in Go menu order (⌘1 to ⌘5). */
export const GO_DESTINATIONS = [
	{ command: "go-all-books", title: "All Books", path: "/" },
	{ command: "go-authors", title: "Authors", path: "/authors" },
	{ command: "go-series", title: "Series", path: "/series" },
	{ command: "go-tags", title: "Tags", path: "/tags" },
	{ command: "go-publishers", title: "Publishers", path: "/publishers" },
] as const satisfies readonly {
	command: MenuCommand;
	title: string;
	path: string;
}[];

export type TGoPath = (typeof GO_DESTINATIONS)[number]["path"];

/** What a menu choice or shortcut does, for the dispatcher to carry out. */
export type MenuAction =
	| { type: "book"; command: TBookCommand }
	| { type: "find" }
	| { type: "toggle-sidebar" }
	| { type: "toggle-unread-only" }
	| { type: "sort"; order: LibraryBookSortOrderKey }
	/** All Books also clears the search and shelf, like the sidebar link. */
	| { type: "go"; path: TGoPath; resetToAllBooks: boolean }
	| { type: "history"; direction: "back" | "forward" }
	| { type: "new-shelf" }
	| { type: "add-library" }
	| { type: "show-library-in-file-manager" }
	| { type: "switch-library"; libraryId: string }
	| { type: "edit"; command: "undo" | "redo" }
	| { type: "select-all" }
	| { type: "add-book" }
	| { type: "open-settings" }
	/** Handled natively (Restart to Update). */
	| { type: "none" };

const BOOK_COMMANDS: Record<string, TBookCommand> = {
	"book-show-details": BOOK_COMMAND.showDetails,
	"book-open": BOOK_COMMAND.open,
	"book-edit": BOOK_COMMAND.edit,
	"book-mark-finished": BOOK_COMMAND.toggleFinished,
	"book-show-in-file-manager": BOOK_COMMAND.showInFileManager,
	"book-copy-title": BOOK_COMMAND.copyTitle,
	"book-delete": BOOK_COMMAND.delete,
};

const SORT_ORDERS: Record<string, LibraryBookSortOrderKey> = {
	"sort-name-az": "nameAz",
	"sort-name-za": "nameZa",
	"sort-author-az": "authorAz",
	"sort-author-za": "authorZa",
};

const APP_ACTIONS: Record<TAppCommand, MenuAction> = {
	"add-book": { type: "add-book" },
	"open-settings": { type: "open-settings" },
};

export const menuAction = (command: TShortcutCommand): MenuAction => {
	if (typeof command !== "string")
		return { type: "switch-library", libraryId: command.switchLibrary };
	const book = BOOK_COMMANDS[command];
	if (book !== undefined) return { type: "book", command: book };
	const order = SORT_ORDERS[command];
	if (order !== undefined) return { type: "sort", order };
	const destination = GO_DESTINATIONS.find(
		(candidate) => candidate.command === command,
	);
	if (destination !== undefined)
		return {
			type: "go",
			path: destination.path,
			resetToAllBooks: destination.command === "go-all-books",
		};
	switch (command) {
		case "find":
			return { type: "find" };
		case "toggle-sidebar":
			return { type: "toggle-sidebar" };
		case "toggle-unread-only":
			return { type: "toggle-unread-only" };
		case "go-back":
			return { type: "history", direction: "back" };
		case "go-forward":
			return { type: "history", direction: "forward" };
		case "new-shelf":
			return { type: "new-shelf" };
		case "add-library":
			return { type: "add-library" };
		case "show-library-in-file-manager":
			return { type: "show-library-in-file-manager" };
		case "undo":
		case "redo":
			return { type: "edit", command };
		case "select-all":
			return { type: "select-all" };
		case "add-book":
		case "open-settings":
			return APP_ACTIONS[command];
		default:
			return { type: "none" };
	}
};

/** Book commands act on the selection: nothing to do without one. */
export const needsSelection = (action: MenuAction): boolean =>
	action.type === "book";

export type PushedMenuState = Omit<MenuState, "updateReadyVersion">;

export interface MenuStateInput {
	selectedBookCount: number;
	selectionAllFinished: boolean;
	/** A text field or a sheet or alert has the keyboard. */
	keyboardBusy: boolean;
	/** The library window is in front (another window's fields are its own). */
	windowActive: boolean;
	sidebarVisible: boolean;
	unreadOnly: boolean;
	sortOrder: LibraryBookSortOrderKey;
	libraries: { id: string; displayName: string }[];
	activeLibraryId: string | undefined;
	/** What Edit > Undo and Redo would do now (`undoTitles`). */
	undo: UndoTitles;
}

/** "Undo Mark as Finished" / "Redo …", null where there is nothing to do. */
export interface UndoTitles {
	undo: string | null;
	redo: string | null;
}

/**
 * Which undo drives Edit > Undo: the open book editor's own (it steps back
 * its saves, with no Redo), else the app's undo history. One source at a
 * time, so the menu never names one and runs the other.
 */
export const undoTitles = ({
	editor,
	history,
}: {
	editor: { open: boolean; canUndo: boolean };
	history: UndoTitles;
}): UndoTitles =>
	editor.open
		? { undo: editor.canUndo ? EDITOR_UNDO_TITLE : null, redo: null }
		: history;

export const EDITOR_UNDO_TITLE = "Undo Edit";

/**
 * What the menu bar should show. While someone types or a sheet is up, the
 * Book menu stands down, so ⌘⌫ deletes text instead of books, and Undo and
 * Redo are the text field's own. Otherwise they name the app's undo and are
 * disabled when there is nothing to undo.
 */
export const menuStateFor = (input: MenuStateInput): PushedMenuState => ({
	selectedBookCount: input.keyboardBusy ? 0 : input.selectedBookCount,
	selectionAllFinished: input.selectionAllFinished,
	sidebarVisible: input.sidebarVisible,
	unreadOnly: input.unreadOnly,
	sortOrder: input.sortOrder,
	libraries: input.libraries.map((library) => ({
		id: library.id,
		name: library.displayName,
		active: library.id === input.activeLibraryId,
	})),
	appUndo: input.windowActive && !input.keyboardBusy,
	undoLabel: input.undo.undo,
	redoLabel: input.undo.redo,
});

const sameField = (a: unknown, b: unknown): boolean =>
	a === b || JSON.stringify(a) === JSON.stringify(b);

/** The fields that changed since the last push; null when none did. */
export const menuStatePatch = (
	previous: PushedMenuState | null,
	next: PushedMenuState,
): Partial<PushedMenuState> | null => {
	if (previous === null) return next;
	const changed = (Object.keys(next) as (keyof PushedMenuState)[]).filter(
		(key) => !sameField(previous[key], next[key]),
	);
	if (changed.length === 0) return null;
	return Object.fromEntries(changed.map((key) => [key, next[key]]));
};
