import type { BookActions } from "./use-book-interactions";
import type React from "react";
import { useMemo } from "react";
import type { LibraryBook } from "@/bindings";
import {
	downloadUrlDragData,
	dragIconPath,
	primaryLocalPath,
	primaryRemoteFile,
} from "@/lib/book-files";
import { bookShortcutHint, shortcutEnvironment } from "@/lib/app-shortcuts";
import { BOOK_COMMAND } from "@/lib/book-menu";
import {
	bookClickIntent,
	clearSelection,
	extendSelection,
	selectedBookCount,
	selectedBooks,
	selectForContextMenu,
	selectOnly,
	toggleBook,
} from "@/lib/book-selection";
import { dragOutGuard } from "@/lib/drag-out-guard";
import {
	currentShownBooks,
	useBookSelectionActions,
} from "@/lib/hooks/use-book-selection";
import {
	type ContextMenuController,
	keyboardMenuEvent,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { usePlatform } from "@/lib/platform/context";
import {
	closeBookDetails,
	openBookDetails,
	updateBookSelection,
	useBookSelectionStore,
} from "@/stores/book-selection/store";
import { useLibraryStore } from "@/stores/library/store";

// Only Chromium reads `DownloadURL`; it is also the only engine with
// `navigator.userAgentData`. Elsewhere a cover drags nothing at all rather
// than its image as web content.
const supportsDownloadUrlDrag = () =>
	typeof navigator !== "undefined" && "userAgentData" in navigator;

/** The DOM id `aria-activedescendant` points the grid at. */
export const bookDomId = (bookId: LibraryBook["id"]) => `book-${bookId}`;

export interface BookGridInteraction {
	bookActions: BookActions;
	menu: ContextMenuController;
	/** The option `aria-activedescendant` names: the cursor's book. */
	activeDescendant: string | undefined;
	/** A click on the grid's empty space clears the selection and details. */
	onBackgroundClick: (event: React.MouseEvent) => void;
	/** The Menu key or Shift-F10 on the grid: the menu for the cursor's book. */
	onGridKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * How the cover grid answers the pointer: a click shows the book's details,
 * ⌘-click and ⇧-click build a selection, a double-click opens the file, and
 * right-click and drag act on the selection. A click on empty grid space
 * clears the selection and closes the details.
 */
export const useBookGridInteraction = (
	books: readonly (LibraryBook | undefined)[],
): BookGridInteraction => {
	const platform = usePlatform();
	const menu = useContextMenu();
	const { run, menuEntries } = useBookSelectionActions();
	const cursor = useBookSelectionStore((state) => state.selection.cursor);
	const cursorBook = cursor >= 0 ? books[cursor] : undefined;

	const bookActions = useMemo<BookActions>(
		() => ({
			onPress: (index, book, modifiers) => {
				const intent = bookClickIntent(modifiers, {
					isMac: platform.os === "macos",
				});
				switch (intent) {
					case "toggle":
						updateBookSelection((selection) =>
							toggleBook(selection, index, book.id),
						);
						return;
					case "extend":
						updateBookSelection((selection) =>
							extendSelection(selection, index, currentShownBooks()),
						);
						return;
					case "show":
						updateBookSelection(() => selectOnly(index, book.id));
						openBookDetails(book);
						return;
					case "open":
						run(
							platform.capabilities.canOpenLocalPaths
								? BOOK_COMMAND.open
								: BOOK_COMMAND.download,
						);
						return;
					case "none":
						return;
				}
			},

			onContextMenu: (event, index, book) => {
				updateBookSelection((selection) =>
					selectForContextMenu(selection, index, book.id),
				);
				const single =
					selectedBookCount(
						useBookSelectionStore.getState().selection,
						currentShownBooks().length,
					) === 1;
				const env = shortcutEnvironment(platform);
				const items = menuEntries().map((entry) => {
					if (entry.type === "separator") return entry;
					const hint = bookShortcutHint(entry.id, env);
					return hint.isSome
						? {
								...entry,
								shortcut: hint.value.label,
								keyShortcuts: hint.value.aria,
							}
						: entry;
				});
				menu.openAt(event, items, single ? book.title : "Book actions");
			},

			onDragStart: (event, index, book) => {
				updateBookSelection((selection) =>
					selectForContextMenu(selection, index, book.id),
				);
				const dragged = selectedBooks(
					useBookSelectionStore.getState().selection,
					currentShownBooks(),
				);
				const { startDrag } = platform.window;
				if (startDrag.isSome) {
					event.preventDefault();
					const paths = dragged.flatMap((candidate) => {
						const path = primaryLocalPath(candidate);
						return path !== null ? [path] : [];
					});
					if (paths.length === 0) return;
					const thumb = useLibraryStore.getState().coverThumbs.get(book.id);
					void startDrag
						.value(paths, dragIconPath(book, thumb) ?? undefined)
						.catch((error: unknown) => console.error(error));
					return;
				}
				const remote = primaryRemoteFile(book);
				if (remote === null || !supportsDownloadUrlDrag()) {
					event.preventDefault();
					return;
				}
				dragOutGuard.begin();
				event.currentTarget.addEventListener(
					"dragend",
					() => dragOutGuard.end(),
					{ once: true },
				);
				event.dataTransfer.effectAllowed = "copy";
				event.dataTransfer.setData("DownloadURL", downloadUrlDragData(remote));
				event.dataTransfer.setData("text/uri-list", remote.url);
			},
		}),
		[platform, menu.openAt, run, menuEntries],
	);

	const onGridKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		if (cursorBook === undefined) return;
		const card = document.getElementById(bookDomId(cursorBook.id));
		if (card === null) return;
		const opened = keyboardMenuEvent(event, card.getBoundingClientRect());
		if (opened.isSome)
			bookActions.onContextMenu(opened.value, cursor, cursorBook);
	};

	const onBackgroundClick = (event: React.MouseEvent) => {
		if (!(event.target instanceof Element)) return;
		if (event.target.closest("[data-book-id], button, a, input, label")) return;
		updateBookSelection(clearSelection);
		closeBookDetails();
	};

	return {
		bookActions,
		menu,
		activeDescendant:
			cursorBook !== undefined ? bookDomId(cursorBook.id) : undefined,
		onBackgroundClick,
		onGridKeyDown,
	};
};
