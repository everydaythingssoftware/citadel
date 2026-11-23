import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import {
	pageShortcuts,
	shortcutEnvironment,
	type TShortcutCommand,
} from "@/lib/app-shortcuts";
import { selectAll } from "@/lib/book-selection";
import { useAddBook } from "@/lib/hooks/use-add-book";
import {
	type AddLibraryFlow,
	useAddLibraryFlow,
} from "@/lib/hooks/use-add-library-flow";
import { useBookSelectionActions } from "@/lib/hooks/use-book-selection";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import { listen } from "@/lib/hooks/use-window-chrome-state";
import { keyboardBusyAt, overlayOpen } from "@/lib/keyboard-owner";
import type { KeyBinding } from "@/lib/keymap";
import {
	appUndo,
	GO_PATHS,
	isBookCommand,
	selectAllOwner,
} from "@/lib/menu-commands";
import { usePlatform } from "@/lib/platform/context";
import { useBookEditor } from "@/stores/book-editor/store";
import { updateBookSelection } from "@/stores/book-selection/store";
import { useLibraryView } from "@/stores/library-view/store";
import { requestFind, setShelfSheetOpen } from "@/stores/menu-requests/store";
import { toggleSidebar } from "@/stores/sidebar/store";
import { redoLast, undoLast, useUndoStore } from "@/stores/undo/store";

const keyboardBusy = () => keyboardBusyAt(document.activeElement);

/**
 * Edit > Undo / Redo: a focused text field's own undo, else the open book
 * editor's, else the app's undo history.
 */
const runUndo = (command: "undo" | "redo") => {
	if (keyboardBusy()) {
		document.execCommand(command);
		return;
	}
	const { editor } = useBookEditor.getState();
	if (editor.isSome) {
		if (command === "undo" && editor.value.undo.isSome)
			editor.value.undo.value();
		return;
	}
	(command === "undo" ? undoLast() : redoLast()).catch((error: unknown) =>
		console.error(`Couldn't ${command}:`, error),
	);
};

const hasUndo = (command: "undo" | "redo") => {
	const undo = appUndo(
		useBookEditor.getState().editor,
		useUndoStore.getState().history,
	);
	return (command === "undo" ? undo.undoLabel : undo.redoLabel) !== null;
};

/**
 * Carries out the menu bar's commands and, where there is no menu bar, the
 * same shortcuts from the keyboard. Mounted once, in the library window's
 * shell; Add Library… opens the flow it returns.
 */
export const useMenuCommands = (): { addLibrary: AddLibraryFlow } => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const router = useRouter();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const selectionActions = useBookSelectionActions();
	const { activeLibrary, switchTo } = useLibrarySelection();
	const addLibrary = useAddLibraryFlow();
	const { startAddBook } = useAddBook();
	const openSettings = useOpenSettings();
	const env = shortcutEnvironment(platform);
	const enabled = platform.window.isMain;

	const toBooks = () => {
		if (pathname !== GO_PATHS.allBooks)
			void navigate({ to: GO_PATHS.allBooks });
	};

	const run = (command: TShortcutCommand) => {
		if (isBookCommand(command)) {
			if (selectionActions.selectedCount > 0) selectionActions.run(command);
			return;
		}
		if (typeof command !== "string") {
			if ("sort" in command)
				useLibraryView.getState().setSortOrder(command.sort);
			else if ("go" in command) {
				// All Books also clears the search and shelf, like the sidebar link.
				if (command.go === "allBooks") {
					useLibraryView.getState().resetToAllBooks();
					void navigate({ to: GO_PATHS.allBooks, search: {} });
				} else void navigate({ to: GO_PATHS[command.go] });
			} else void switchTo(command.switchLibrary);
			return;
		}
		switch (command) {
			case "find":
				toBooks();
				requestFind();
				return;
			case "new-shelf":
				toBooks();
				setShelfSheetOpen(true);
				return;
			case "toggle-sidebar":
				toggleSidebar();
				return;
			case "toggle-unread-only": {
				const view = useLibraryView.getState();
				view.setHideRead(!view.hideRead);
				return;
			}
			case "go-back":
				router.history.back();
				return;
			case "go-forward":
				router.history.forward();
				return;
			case "add-library":
				addLibrary.start();
				return;
			case "show-library-in-file-manager":
				if (activeLibrary && platform.capabilities.canRevealInFileManager)
					platform.fileOpener
						.revealInFileManager(activeLibrary.absolutePath)
						.catch((error: unknown) => console.error("Show library:", error));
				return;
			case "undo":
			case "redo":
				runUndo(command);
				return;
			case "select-all":
				if (selectAllOwner(keyboardBusy(), pathname) === "books")
					updateBookSelection(selectAll);
				else document.execCommand("selectAll");
				return;
			case "add-book":
				startAddBook();
				return;
			case "open-settings":
				openSettings();
		}
	};

	const onMenuCommand = useEffectEvent(run);
	useEffect(() => {
		if (!enabled || !platform.menu.isSome) return;
		return listen(platform.menu.value.onCommand(onMenuCommand), "Menu bar");
	}, [enabled, platform]);

	const guard = (
		command: TShortcutCommand,
	): Pick<KeyBinding, "when" | "allowInEditable"> => {
		if (isBookCommand(command))
			return {
				when: () => selectionActions.selectedCount > 0 && !keyboardBusy(),
			};
		switch (command) {
			case "find":
				// A browser keeps its own Find on pages without a search field.
				return {
					allowInEditable: true,
					when: () =>
						!overlayOpen() && (env.desktop || pathname === GO_PATHS.allBooks),
				};
			case "go-back":
			case "go-forward":
				return { when: () => !overlayOpen() };
			case "undo":
			case "redo":
				// Nothing to undo: the key stays the browser's and the field's.
				return { when: () => !keyboardBusy() && hasUndo(command) };
			default:
				return { allowInEditable: true, when: () => !overlayOpen() };
		}
	};
	useKeymap(
		enabled
			? pageShortcuts(env).map(({ command, chord }) => ({
					chord,
					onMatch: () => run(command),
					...guard(command),
				}))
			: [],
	);

	return { addLibrary };
};
