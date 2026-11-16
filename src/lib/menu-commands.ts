import type {
	GoDestination,
	MenuLibrary,
	MenuSelection,
	MenuStateUpdate,
	MenuUndo,
	MenuViewOptions,
} from "@/bindings";
import type { TShortcutCommand } from "@/lib/app-shortcuts";
import { BOOK_COMMAND, type TBookCommand } from "@/lib/book-menu";
import type { LibraryBookSortOrderKey } from "@/stores/library-view/store";

/** Where each Go item (⌘1 to ⌘5) leads. */
export const GO_PATHS = {
	allBooks: "/",
	authors: "/authors",
	series: "/series",
	tags: "/tags",
	publishers: "/publishers",
} as const satisfies Record<GoDestination, string>;

export type TGoPath = (typeof GO_PATHS)[GoDestination];

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
	| { type: "add-book" }
	| { type: "open-settings" };

const BOOK_COMMANDS = {
	"book-show-details": BOOK_COMMAND.showDetails,
	"book-open": BOOK_COMMAND.open,
	"book-edit": BOOK_COMMAND.edit,
	"book-mark-finished": BOOK_COMMAND.toggleFinished,
	"book-show-in-file-manager": BOOK_COMMAND.showInFileManager,
	"book-copy-title": BOOK_COMMAND.copyTitle,
	"book-delete": BOOK_COMMAND.delete,
} as const;

export const menuAction = (command: TShortcutCommand): MenuAction => {
	if (typeof command !== "string") {
		if ("sort" in command) return { type: "sort", order: command.sort };
		if ("go" in command)
			return {
				type: "go",
				path: GO_PATHS[command.go],
				resetToAllBooks: command.go === "allBooks",
			};
		return { type: "switch-library", libraryId: command.switchLibrary };
	}
	switch (command) {
		case "book-show-details":
		case "book-open":
		case "book-edit":
		case "book-mark-finished":
		case "book-show-in-file-manager":
		case "book-copy-title":
		case "book-delete":
			return { type: "book", command: BOOK_COMMANDS[command] };
		case "go-back":
			return { type: "history", direction: "back" };
		case "go-forward":
			return { type: "history", direction: "forward" };
		case "undo":
		case "redo":
			return { type: "edit", command };
		case "find":
		case "toggle-sidebar":
		case "toggle-unread-only":
		case "new-shelf":
		case "add-library":
		case "show-library-in-file-manager":
		case "add-book":
		case "open-settings":
			return { type: command };
	}
};

/** Book commands act on the selection: nothing to do without one. */
export const needsSelection = (action: MenuAction): boolean =>
	action.type === "book";

/** What the window pushes to the menu bar, one group per concern. */
export interface MenuBarState {
	selection: MenuSelection;
	view: MenuViewOptions;
	libraries: MenuLibrary[];
	undo: MenuUndo;
}

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
export const menuStateFor = (input: MenuStateInput): MenuBarState => ({
	selection: {
		count: input.keyboardBusy ? 0 : input.selectedBookCount,
		allFinished: input.selectionAllFinished,
	},
	view: {
		sidebarVisible: input.sidebarVisible,
		unreadOnly: input.unreadOnly,
		sortOrder: input.sortOrder,
	},
	libraries: input.libraries.map((library) => ({
		id: library.id,
		name: library.displayName,
		active: library.id === input.activeLibraryId,
	})),
	undo:
		input.windowActive && !input.keyboardBusy
			? { owner: "app", undoLabel: input.undo.undo, redoLabel: input.undo.redo }
			: { owner: "textField" },
});

const groups = (state: MenuBarState): MenuStateUpdate[] => [
	{ selection: state.selection },
	{ view: state.view },
	{ libraries: state.libraries },
	{ undo: state.undo },
];

/** The groups that changed since the last push, each sent whole. */
export const menuStateUpdates = (
	previous: MenuBarState | null,
	next: MenuBarState,
): MenuStateUpdate[] => {
	const pushed =
		previous === null
			? []
			: groups(previous).map((group) => JSON.stringify(group));
	return groups(next).filter(
		(group, index) => JSON.stringify(group) !== pushed[index],
	);
};
