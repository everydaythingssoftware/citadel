import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useBookSelectionActions } from "@/lib/hooks/use-book-selection";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { listen } from "@/lib/hooks/use-window-chrome-state";
import { keyboardBusyAt } from "@/lib/keyboard-owner";
import { appUndo, selectAllOwner } from "@/lib/menu-commands";
import { usePlatform } from "@/lib/platform/context";
import type { MenuStateUpdate, PlatformAdapter } from "@/lib/platform/types";
import { useBookEditor } from "@/stores/book-editor/store";
import { useLibraryView } from "@/stores/library-view/store";
import { useSidebar } from "@/stores/sidebar/store";
import { useUndoStore } from "@/stores/undo/store";

/** Tracks whether a field or overlay has the keyboard, as focus moves. */
const useKeyboardBusy = (): boolean => {
	const [busy, setBusy] = useState(() =>
		keyboardBusyAt(document.activeElement),
	);
	useEffect(() => {
		// focusout lands on <body> before the next focusin; read once both ran.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const update = () => {
			clearTimeout(timer);
			timer = setTimeout(
				() => setBusy(keyboardBusyAt(document.activeElement)),
				0,
			);
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

const useWindowActive = (platform: PlatformAdapter): boolean => {
	const [active, setActive] = useState(true);
	useEffect(
		() => listen(platform.window.onActiveChange(setActive), "Window focus"),
		[platform],
	);
	return active;
};

const push = (platform: PlatformAdapter, update: MenuStateUpdate) => {
	if (!platform.window.isMain || !platform.menu.isSome) return;
	platform.menu.value
		.setState(update)
		.catch((error: unknown) =>
			console.error("Failed to update the menu bar:", error),
		);
};

/**
 * Tells the macOS menu bar what the library window shows, one group at a
 * time as it changes. While someone types or a sheet is up, the Book menu
 * stands down (⌘⌫ deletes text, not books) and Undo and Redo are the text
 * field's own. On the Books page, Select All selects the books, unless the
 * focus is in a text field, a sheet, an alert or a menu.
 */
export const useMenuBarSync = () => {
	const platform = usePlatform();
	const { selectedCount, allFinished } = useBookSelectionActions();
	const { libraries, activeLibrary } = useLibrarySelection();
	const sidebarVisible = useSidebar((state) => state.visible);
	const unreadOnly = useLibraryView((state) => state.hideRead);
	const sortOrder = useLibraryView((state) => state.sortOrder);
	const editor = useBookEditor((state) => state.editor);
	const history = useUndoStore((state) => state.history);
	const busy = useKeyboardBusy();
	const windowActive = useWindowActive(platform);
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	const count = busy ? 0 : selectedCount;
	useEffect(
		() => push(platform, { selection: { count, allFinished } }),
		[platform, count, allFinished],
	);

	useEffect(
		() => push(platform, { view: { sidebarVisible, unreadOnly, sortOrder } }),
		[platform, sidebarVisible, unreadOnly, sortOrder],
	);

	const activeLibraryId = activeLibrary?.id;
	useEffect(
		() =>
			push(platform, {
				libraries: libraries.map((library) => ({
					id: library.id,
					name: library.displayName,
					active: library.id === activeLibraryId,
				})),
			}),
		[platform, libraries, activeLibraryId],
	);

	const appOwnsUndo = windowActive && !busy;
	const { undoLabel, redoLabel } = appUndo(editor, history);
	useEffect(
		() =>
			push(platform, {
				undo: appOwnsUndo
					? { owner: "app", undoLabel, redoLabel }
					: { owner: "textField" },
			}),
		[platform, appOwnsUndo, undoLabel, redoLabel],
	);

	const selectAll = windowActive ? selectAllOwner(busy, pathname) : "native";
	useEffect(() => push(platform, { selectAll }), [platform, selectAll]);
};
