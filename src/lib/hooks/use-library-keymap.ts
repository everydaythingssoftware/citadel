import type { RefObject } from "react";
import type { LibraryBook } from "@/bindings";
import {
	clearSelection,
	extendSelection,
	selectAll,
	selectOnly,
} from "@/lib/book-selection";
import {
	followWithDetails,
	updateBookSelection,
	useBookSelectionStore,
} from "@/lib/hooks/use-book-selection";
import { useKeymap } from "@/lib/hooks/use-keymap";
import type { KeyBinding, SelectionDirection } from "@/lib/keymap";
import { moveSelection } from "@/lib/keymap";

interface LibraryKeymapOptions {
	/**
	 * Indexed view of the filtered library: length is the total match count,
	 * `undefined` entries are books whose page has not been fetched yet.
	 * The cursor tracks the INDEX, so arrow keys can move onto an unfetched
	 * slot; the scroll-into-view below makes its page load, and the book
	 * joins the selection once it arrives (use-book-selection).
	 */
	books: (LibraryBook | undefined)[];
	drawerOpened: boolean;
	searchInputRef: RefObject<HTMLInputElement | null>;
	gridContainerRef: RefObject<HTMLElement | null>;
	/**
	 * The virtualized grid's scroll-to-index function (BookGrid). The cursor
	 * can land on a row that is not mounted; this brings the row into view so
	 * the selected card mounts and renders its ring.
	 */
	scrollToBookIndexRef?: RefObject<((index: number) => void) | null>;
	/** Return: show the cursor's book in the details drawer. */
	onBookOpen: (book: LibraryBook) => void;
	/** Space: Quick Look, where the platform has it. */
	onQuickLook?: (book: LibraryBook) => void;
	onClearSearch: () => void;
}

const ARROW_CHORDS: [string, SelectionDirection][] = [
	["arrowup", "up"],
	["arrowdown", "down"],
	["arrowleft", "left"],
	["arrowright", "right"],
];

// The cover grid's column count exists only in layout (it is derived from
// the container width); read it off the resolved grid-template-columns track
// list of any mounted shelf row.
const measureColumns = (container: HTMLElement | null): number => {
	const grid = container?.querySelector("[data-books-grid]");
	if (!(grid instanceof HTMLElement)) return 1;
	const tracks = window.getComputedStyle(grid).gridTemplateColumns;
	const count = tracks.split(" ").filter((track) => track !== "").length;
	return Math.max(count, 1);
};

// An open menu, sheet or alert owns the keyboard; the grid behind it must
// not move its selection on the same keystroke.
const OVERLAY_SELECTOR = '[role="menu"], [role="dialog"], [role="alertdialog"]';
const gridOwnsKeyboard = () =>
	!(document.activeElement?.closest(OVERLAY_SELECTOR) ?? null);

// The details drawer shows the selection, so arrows pressed in it still
// move through the grid, unless they belong to a control there (a list,
// a pop-up, a field).
const ARROW_WIDGETS =
	'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="combobox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="tree"], [role="grid"]';
const arrowsMoveGrid = (grid: RefObject<HTMLElement | null>) => () => {
	const focused = document.activeElement;
	if (focused === null || focused === grid.current || focused === document.body)
		return true;
	if (focused.closest('[role="alertdialog"], [role="menu"]')) return false;
	const inDrawer = focused.closest("[data-drawer]") !== null;
	if (!inDrawer) return gridOwnsKeyboard();
	return focused.closest(ARROW_WIDGETS) === null;
};

export const useLibraryKeymap = ({
	books,
	drawerOpened,
	searchInputRef,
	gridContainerRef,
	scrollToBookIndexRef,
	onBookOpen,
	onQuickLook,
	onClearSearch,
}: LibraryKeymapOptions): void => {
	const selection = useBookSelectionStore((state) => state.selection);
	const cursor =
		selection.cursor >= 0 && selection.cursor < books.length
			? selection.cursor
			: -1;
	const cursorBook = cursor >= 0 ? books[cursor] : undefined;

	const revealIndex = (index: number) => {
		// The grid is virtualized: the target row may not be mounted, so ask
		// the virtualizer to scroll it into view first (which also pages the
		// books covering it in). When the card is already mounted, the
		// follow-up scrollIntoView fine-tunes alignment.
		scrollToBookIndexRef?.current?.(index);
		const book = books[index];
		if (book !== undefined) {
			document
				.querySelector(`[data-book-id="${CSS.escape(book.id)}"]`)
				?.scrollIntoView({ block: "nearest" });
		}
	};

	const moveBy = (direction: SelectionDirection, extend: boolean) => {
		const nextIndex = moveSelection({
			index: cursor,
			count: books.length,
			columns: measureColumns(gridContainerRef.current),
			direction,
		});
		if (nextIndex < 0 || nextIndex >= books.length) return;
		updateBookSelection((current) =>
			extend
				? extendSelection(current, nextIndex, books)
				: selectOnly(nextIndex, books[nextIndex]?.id),
		);
		const book = books[nextIndex];
		if (book !== undefined && !extend) followWithDetails(book);
		revealIndex(nextIndex);
	};

	// Spotlight-style hand-off: commit the query and drop into the results.
	const leaveSearchForGrid = () => {
		gridContainerRef.current?.focus();
		if (books.length === 0) return;
		updateBookSelection(() => selectOnly(0, books[0]?.id));
		revealIndex(0);
	};

	const bindings: KeyBinding[] = [];

	if (!drawerOpened) {
		bindings.push(
			{
				chord: "escape",
				allowInEditable: true,
				when: () => document.activeElement === searchInputRef.current,
				onMatch: () => {
					onClearSearch();
					gridContainerRef.current?.focus();
				},
			},
			{
				chord: "enter",
				allowInEditable: true,
				when: () => document.activeElement === searchInputRef.current,
				onMatch: leaveSearchForGrid,
			},
			{
				chord: "arrowdown",
				allowInEditable: true,
				when: () => document.activeElement === searchInputRef.current,
				onMatch: leaveSearchForGrid,
			},
			{
				chord: "mod+a",
				when: gridOwnsKeyboard,
				onMatch: () => updateBookSelection(selectAll),
			},
			{
				chord: "escape",
				when: gridOwnsKeyboard,
				onMatch: () => updateBookSelection(clearSelection),
			},
		);
		if (cursorBook !== undefined) {
			bindings.push({
				chord: "enter",
				when: gridOwnsKeyboard,
				onMatch: () => onBookOpen(cursorBook),
			});
		}
	}
	const arrowsAllowed = arrowsMoveGrid(gridContainerRef);
	for (const [chord, direction] of ARROW_CHORDS) {
		bindings.push(
			{
				chord,
				when: arrowsAllowed,
				onMatch: () => moveBy(direction, false),
			},
			{
				chord: `shift+${chord}`,
				when: arrowsAllowed,
				onMatch: () => moveBy(direction, true),
			},
		);
	}
	if (cursorBook !== undefined && onQuickLook) {
		bindings.push({
			chord: "space",
			when: gridOwnsKeyboard,
			onMatch: () => onQuickLook(cursorBook),
		});
	}

	useKeymap(bindings);
};
