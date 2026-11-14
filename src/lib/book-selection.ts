import type { LibraryBook } from "@/bindings";

type BookId = LibraryBook["id"];

/** Inclusive flat-index range of the filtered result. */
export interface IndexRange {
	start: number;
	end: number;
}

/**
 * Which books of the filtered, paged result are selected.
 *
 * Ids, not positions, decide membership, so a book added or removed in the
 * background never shifts the selection onto a different book. Two cases
 * can't name their ids yet because their pages haven't been fetched:
 * - Select All covers the whole result (`mode: "all"`, with `ids` holding
 *   the books ⌘-clicked back out), resolved to ids only when acted on.
 * - Indices in `pending` (a ⇧-range or arrow move over unfetched slots) join
 *   `ids` as their books arrive (`materializePending`).
 *
 * `anchor` is where ⇧-extension starts, `cursor` the keyboard position, and
 * `base` the ids selected when the anchor was set, so a later ⇧-click
 * replaces the previous range instead of adding to it, the way Finder's
 * list view does.
 */
export interface BookSelection {
	readonly mode: "some" | "all";
	readonly ids: ReadonlySet<BookId>;
	readonly pending: IndexRange | null;
	readonly anchor: number;
	readonly cursor: number;
	readonly base: ReadonlySet<BookId>;
}

const NONE = -1;
const EMPTY: ReadonlySet<BookId> = new Set();

export const emptySelection: BookSelection = {
	mode: "some",
	ids: EMPTY,
	pending: null,
	anchor: NONE,
	cursor: NONE,
	base: EMPTY,
};

const inRange = (range: IndexRange | null, index: number): boolean =>
	range !== null && index >= range.start && index <= range.end;

export const isBookSelected = (
	selection: BookSelection,
	id: BookId,
	index?: number,
): boolean => {
	if (selection.mode === "all") return !selection.ids.has(id);
	if (selection.ids.has(id)) return true;
	return index !== undefined && inRange(selection.pending, index);
};

/** True when nothing is selected (Select All over an empty result included). */
export const isSelectionEmpty = (
	selection: BookSelection,
	total: number,
): boolean => selectedBookCount(selection, total) === 0;

/**
 * How many books are selected. Pending indices are counted once each, even
 * though a few of them may already be in `ids` from an earlier range.
 */
export const selectedBookCount = (
	selection: BookSelection,
	total: number,
): number => {
	if (selection.mode === "all") return Math.max(total - selection.ids.size, 0);
	const pending = selection.pending
		? Math.max(
				Math.min(selection.pending.end, total - 1) -
					selection.pending.start +
					1,
				0,
			)
		: 0;
	return selection.ids.size + pending;
};

/** A plain click: only this book. */
export const selectOnly = (
	index: number,
	id: BookId | undefined,
): BookSelection => {
	const ids: ReadonlySet<BookId> = id !== undefined ? new Set([id]) : EMPTY;
	return {
		mode: "some",
		ids,
		pending: id === undefined ? { start: index, end: index } : null,
		anchor: index,
		cursor: index,
		base: EMPTY,
	};
};

/** ⌘-click (Ctrl-click off the Mac): flips one book in or out. */
export const toggleBook = (
	selection: BookSelection,
	index: number,
	id: BookId,
): BookSelection => {
	const ids = new Set(selection.ids);
	if (ids.has(id)) ids.delete(id);
	else ids.add(id);
	return {
		mode: selection.mode,
		ids,
		pending: selection.pending,
		anchor: index,
		cursor: index,
		base: selection.mode === "some" ? ids : EMPTY,
	};
};

/**
 * ⇧-click or ⇧-arrow: everything from the anchor to `index`, on top of
 * what was selected when the anchor was set. Unfetched slots in the range
 * stay pending until their books arrive.
 */
export const extendSelection = (
	selection: BookSelection,
	index: number,
	books: readonly (LibraryBook | undefined)[],
): BookSelection => {
	const anchor =
		selection.anchor >= 0 && selection.anchor < books.length
			? selection.anchor
			: index;
	const base = selection.mode === "all" ? EMPTY : selection.base;
	const start = Math.min(anchor, index);
	const end = Math.max(anchor, index);
	const ids = new Set(base);
	let firstMissing = NONE;
	let lastMissing = NONE;
	for (let position = start; position <= end; position++) {
		const book = books[position];
		if (book !== undefined) {
			ids.add(book.id);
			continue;
		}
		if (firstMissing === NONE) firstMissing = position;
		lastMissing = position;
	}
	return {
		mode: "some",
		ids,
		pending:
			firstMissing === NONE ? null : { start: firstMissing, end: lastMissing },
		anchor,
		cursor: index,
		base,
	};
};

/** ⌘A: the whole filtered result, fetched or not. */
export const selectAll = (selection: BookSelection): BookSelection => ({
	mode: "all",
	ids: EMPTY,
	pending: null,
	anchor: selection.anchor,
	cursor: selection.cursor,
	base: EMPTY,
});

/** Escape or a click on empty grid space. Keeps the keyboard position. */
export const clearSelection = (selection: BookSelection): BookSelection => ({
	...emptySelection,
	cursor: selection.cursor,
	anchor: selection.cursor,
});

/** Adds pending indices whose books have arrived to `ids`. */
export const materializePending = (
	selection: BookSelection,
	books: readonly (LibraryBook | undefined)[],
): BookSelection => {
	const { pending } = selection;
	if (pending === null) return selection;
	const end = Math.min(pending.end, books.length - 1);
	if (end < pending.start) return { ...selection, pending: null };
	let added = false;
	const ids = new Set(selection.ids);
	let firstMissing = NONE;
	let lastMissing = NONE;
	for (let position = pending.start; position <= end; position++) {
		const book = books[position];
		if (book === undefined) {
			if (firstMissing === NONE) firstMissing = position;
			lastMissing = position;
			continue;
		}
		ids.add(book.id);
		added = true;
	}
	if (!added && firstMissing === pending.start && lastMissing === pending.end)
		return selection;
	return {
		...selection,
		ids,
		pending:
			firstMissing === NONE ? null : { start: firstMissing, end: lastMissing },
	};
};

/** Indices still to fetch before every selected book can be named. */
export const unresolvedRange = (
	selection: BookSelection,
	total: number,
): IndexRange | null => {
	if (total <= 0) return null;
	if (selection.mode === "all") return { start: 0, end: total - 1 };
	if (selection.pending === null) return null;
	const end = Math.min(selection.pending.end, total - 1);
	return end < selection.pending.start
		? null
		: { start: selection.pending.start, end };
};

/** The selected books that are loaded, in grid order. */
export const selectedBooks = (
	selection: BookSelection,
	books: readonly (LibraryBook | undefined)[],
): LibraryBook[] => {
	if (
		selection.mode === "some" &&
		selection.ids.size === 0 &&
		selection.pending === null
	)
		return [];
	const result: LibraryBook[] = [];
	books.forEach((book, index) => {
		if (book !== undefined && isBookSelected(selection, book.id, index))
			result.push(book);
	});
	return result;
};

/**
 * Right-click: a book outside the selection becomes the selection; one
 * inside it keeps the whole selection, so the menu acts on all of them.
 */
export const selectForContextMenu = (
	selection: BookSelection,
	index: number,
	id: BookId,
): BookSelection =>
	isBookSelected(selection, id, index) ? selection : selectOnly(index, id);

export interface BookClickModifiers {
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	/** The click count (`MouseEvent.detail`): 2 on a double-click. */
	detail: number;
}

export type BookClickIntent = "show" | "toggle" | "extend" | "open" | "none";

/**
 * What a click on a cover does, the same on every platform: a click (or
 * tap) selects the book and shows its details; ⌘-click (Ctrl-click off the
 * Mac) toggles it in the selection and ⇧-click extends it, both without the
 * details; the second click of a double-click opens the book's file. Later
 * clicks of a triple-click do nothing, so the file opens once.
 */
export const bookClickIntent = (
	modifiers: BookClickModifiers,
	{ isMac }: { isMac: boolean },
): BookClickIntent => {
	if (modifiers.shiftKey) return "extend";
	if (isMac ? modifiers.metaKey : modifiers.ctrlKey) return "toggle";
	if (modifiers.detail === 2) return "open";
	return modifiers.detail > 2 ? "none" : "show";
};

/** A move under this many pixels between press and release is still a click. */
export const CLICK_SLOP_PX = 4;

export const movedBeyondClickSlop = (
	from: { x: number; y: number },
	to: { x: number; y: number },
): boolean => Math.hypot(to.x - from.x, to.y - from.y) > CLICK_SLOP_PX;
