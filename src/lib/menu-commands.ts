import type { AppUndo, GoDestination } from "@/bindings";
import type { TShortcutCommand } from "@/lib/app-shortcuts";
import { BOOK_COMMAND, type TBookCommand } from "@/lib/book-menu";
import type { Option } from "@/lib/option";
import { redoTitle, type UndoHistory, undoTitle } from "@/lib/undo-history";
import type { OpenBookEditor } from "@/stores/book-editor/store";

/** Where each Go item (⌘1 to ⌘5) leads. */
export const GO_PATHS = {
	allBooks: "/",
	authors: "/authors",
	series: "/series",
	tags: "/tags",
	publishers: "/publishers",
} as const satisfies Record<GoDestination, string>;

const BOOK_COMMANDS: readonly string[] = Object.values(BOOK_COMMAND);

/** The Book menu's items are the selection's own commands, by name. */
export const isBookCommand = (
	command: TShortcutCommand,
): command is TShortcutCommand & TBookCommand =>
	typeof command === "string" && BOOK_COMMANDS.includes(command);

/**
 * What Edit > Undo and Redo do: the open book editor's own Undo (it steps
 * back its saves, with no Redo), else the app's undo history. One source at
 * a time, so the menu never names one and runs the other.
 */
export const appUndo = (
	editor: Option<OpenBookEditor>,
	history: UndoHistory,
): AppUndo =>
	editor.isSome
		? {
				undoLabel: editor.value.undo.isSome ? "Undo Edit" : null,
				redoLabel: null,
			}
		: { undoLabel: undoTitle(history), redoLabel: redoTitle(history) };
