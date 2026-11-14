import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAddBook } from "@/components/organisms/AddBook";
import {
	menuBarOwnsChords,
	pageShortcuts,
	type ShortcutEnvironment,
	type TShortcutCommand,
} from "@/lib/app-shortcuts";
import { selectAll } from "@/lib/book-selection";
import { keyboardBusyAt } from "@/lib/keyboard-owner";
import type { KeyBinding } from "@/lib/keymap";
import {
	type AddLibraryFlow,
	useAddLibraryFlow,
} from "@/lib/hooks/use-add-library-flow";
import {
	updateBookSelection,
	useBookSelectionActions,
} from "@/lib/hooks/use-book-selection";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import {
	type MenuAction,
	menuAction,
	menuStateFor,
	menuStatePatch,
	type PushedMenuState,
	type UndoTitles,
	undoTitles,
} from "@/lib/menu-commands";
import { usePlatform } from "@/lib/platform/context";
import { useBookEditor } from "@/stores/book-editor/store";
import { useLibraryView } from "@/stores/library-view/store";
import { requestFind, setShelfSheetOpen } from "@/stores/menu-requests/store";
import { toggleSidebar, useSidebar } from "@/stores/sidebar/store";
import { redoLast, undoLast, useUndoStore } from "@/stores/undo/store";
import { redoTitle, type UndoHistory, undoTitle } from "@/lib/undo-history";
import type { PlatformAdapter } from "@/lib/platform/types";

/** Coalesces bursts (a ⇧-click range, focus hopping) into one push. */
const PUSH_DELAY_MS = 40;

// Radix keeps overlay content mounted only while open, so any open dialog
// (drawer, sheet, alert) in the DOM owns the keyboard for navigation chords.
const overlayOpen = () =>
	document.querySelector(
		'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
	) !== null;

const keyboardBusy = () =>
	keyboardBusyAt(document.activeElement as HTMLElement | null);

/** Tracks whether a field or overlay has the keyboard, as focus moves. */
const useKeyboardBusy = (): boolean => {
	const [busy, setBusy] = useState(keyboardBusy);
	useEffect(() => {
		// focusout lands on <body> before the next focusin; read once both ran.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const update = () => {
			clearTimeout(timer);
			timer = setTimeout(() => setBusy(keyboardBusy()), 0);
		};
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", update);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", update);
		};
	}, []);
	return busy;
};

/** Whether the library window is in front, as it changes. */
const useWindowActive = (platform: PlatformAdapter): boolean => {
	const [active, setActive] = useState(true);
	useEffect(() => {
		let stop: (() => void) | undefined;
		let cancelled = false;
		platform.window
			.onActiveChange(setActive)
			.then((unlisten) => {
				if (cancelled) unlisten();
				else stop = unlisten;
			})
			.catch((error: unknown) => console.error("Window focus:", error));
		return () => {
			cancelled = true;
			stop?.();
		};
	}, [platform]);
	return active;
};

const historyTitles = (history: UndoHistory): UndoTitles => ({
	undo: undoTitle(history),
	redo: redoTitle(history),
});

/** What Edit > Undo and Redo would do right now. */
const currentUndoTitles = (): UndoTitles =>
	undoTitles({
		editor: useBookEditor.getState(),
		history: historyTitles(useUndoStore.getState().history),
	});

/**
 * Edit > Undo / Redo (⌘Z / ⇧⌘Z, Ctrl+Z / Ctrl+Shift+Z off the Mac): a
 * focused text field's own undo, else the open book editor's, else the
 * app's undo history.
 */
const runUndo = (command: "undo" | "redo") => {
	if (keyboardBusy()) {
		document.execCommand(command);
		return;
	}
	const editor = useBookEditor.getState();
	if (editor.open) {
		if (command === "undo" && editor.canUndo) editor.undo();
		return;
	}
	(command === "undo" ? undoLast() : redoLast()).catch((error: unknown) =>
		console.error(`Couldn't ${command}:`, error),
	);
};

const BOOKS_PATH = "/";

export interface MenuCommands {
	/** Add Library… from the menu bar; render `AddLibraryDialog` with it. */
	addLibrary: AddLibraryFlow;
}

/**
 * Carries out the menu bar's commands and, where there is no menu bar, the
 * same shortcuts from the keyboard; and tells the menu bar what to show.
 * Mounted once, in the library window's shell.
 */
export const useMenuCommands = (): MenuCommands => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const router = useRouter();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const selectionActions = useBookSelectionActions();
	const { libraries, activeLibrary, switchTo } = useLibrarySelection();
	const addLibrary = useAddLibraryFlow();
	const { startAddBook } = useAddBook();
	const openSettings = useOpenSettings();
	const sidebarVisible = useSidebar((state) => state.visible);
	const unreadOnly = useLibraryView((state) => state.hideRead);
	const sortOrder = useLibraryView((state) => state.sortOrder);
	const editorOpen = useBookEditor((state) => state.open);
	const editorCanUndo = useBookEditor((state) => state.canUndo);
	const history = useUndoStore((state) => state.history);
	const undo = useMemo(
		() =>
			undoTitles({
				editor: { open: editorOpen, canUndo: editorCanUndo },
				history: historyTitles(history),
			}),
		[editorOpen, editorCanUndo, history],
	);
	const busy = useKeyboardBusy();
	const windowActive = useWindowActive(platform);

	const env = useMemo<ShortcutEnvironment>(
		() => ({
			os: platform.os,
			desktop: platform.capabilities.supportsNativeWindows,
		}),
		[platform],
	);
	const enabled = platform.window.isMain;

	const run = (action: MenuAction) => {
		switch (action.type) {
			case "book":
				if (selectionActions.selectedCount > 0)
					selectionActions.run(action.command);
				return;
			case "find":
				if (pathname !== BOOKS_PATH) void navigate({ to: BOOKS_PATH });
				requestFind();
				return;
			case "toggle-sidebar":
				toggleSidebar();
				return;
			case "toggle-unread-only": {
				const view = useLibraryView.getState();
				view.setHideRead(!view.hideRead);
				return;
			}
			case "sort":
				useLibraryView.getState().setSortOrder(action.order);
				return;
			case "go":
				if (action.resetToAllBooks) useLibraryView.getState().resetToAllBooks();
				void navigate({
					to: action.path,
					...(action.path === BOOKS_PATH ? { search: {} } : {}),
				});
				return;
			case "history":
				if (action.direction === "back") router.history.back();
				else router.history.forward();
				return;
			case "new-shelf":
				if (pathname !== BOOKS_PATH) void navigate({ to: BOOKS_PATH });
				setShelfSheetOpen(true);
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
			case "switch-library":
				void switchTo(action.libraryId);
				return;
			case "edit":
				runUndo(action.command);
				return;
			case "select-all":
				if (keyboardBusy()) document.execCommand("selectAll");
				else updateBookSelection(selectAll);
				return;
			case "add-book":
				startAddBook();
				return;
			case "open-settings":
				openSettings();
				return;
			case "none":
				return;
		}
	};
	const runRef = useRef(run);
	runRef.current = run;

	useEffect(() => {
		if (!enabled) return;
		const unlisten = platform.menu.onCommand((command) =>
			runRef.current(menuAction(command)),
		);
		return () => {
			void unlisten.then((dispose) => dispose());
		};
	}, [enabled, platform]);

	const bindings: KeyBinding[] = enabled
		? pageShortcuts(env).map(({ command, chord }) => bindingFor(command, chord))
		: [];
	function bindingFor(command: TShortcutCommand, chord: string): KeyBinding {
		const action = menuAction(command);
		const onMatch = () => runRef.current(action);
		switch (action.type) {
			case "book":
				return {
					chord,
					when: () => selectionActions.selectedCount > 0 && !keyboardBusy(),
					onMatch,
				};
			case "find":
				// A browser keeps its own Find on pages without a search field.
				return {
					chord,
					allowInEditable: true,
					when: () => !overlayOpen() && (env.desktop || pathname === "/"),
					onMatch,
				};
			case "history":
				return { chord, when: () => !overlayOpen(), onMatch };
			case "edit":
				// Nothing to undo: the key stays the browser's and the field's.
				return {
					chord,
					when: () =>
						!keyboardBusy() && currentUndoTitles()[action.command] !== null,
					onMatch,
				};
			default:
				return {
					chord,
					allowInEditable: true,
					when: () => !overlayOpen(),
					onMatch,
				};
		}
	}
	useKeymap(bindings);

	const pushesState = enabled && menuBarOwnsChords(env);
	const state = useMemo(
		() =>
			menuStateFor({
				selectedBookCount: selectionActions.selectedCount,
				selectionAllFinished: selectionActions.allFinished,
				keyboardBusy: busy,
				windowActive,
				sidebarVisible,
				unreadOnly,
				sortOrder,
				libraries,
				activeLibraryId: activeLibrary?.id,
				undo,
			}),
		[
			selectionActions.selectedCount,
			selectionActions.allFinished,
			busy,
			windowActive,
			sidebarVisible,
			unreadOnly,
			sortOrder,
			libraries,
			activeLibrary?.id,
			undo,
		],
	);
	const pushed = useRef<PushedMenuState | null>(null);
	useEffect(() => {
		if (!pushesState) return;
		const timer = setTimeout(() => {
			const patch = menuStatePatch(pushed.current, state);
			if (patch === null) return;
			pushed.current = state;
			platform.menu
				.setState(patch)
				.catch((error: unknown) =>
					console.error("Failed to update the menu bar:", error),
				);
		}, PUSH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [pushesState, state, platform]);

	return { addLibrary };
};
