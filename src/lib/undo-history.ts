import type { BookEdit, EditBooksOutcome } from "@/bindings";
import { booksTitle } from "@/lib/book-count";
import { none, type Option, some } from "@/lib/option";

/**
 * One undo history for the library window, modelled on AppKit's
 * NSUndoManager: Edit > Undo and Redo always name the top entry ("Undo Mark
 * as Finished") and are disabled when there is none.
 *
 * The rule for every action that changes the library (or what the window
 * shows of it, like shelves): it does exactly one of two things.
 * - It registers an entry (a name, how to undo it, how to redo it), or
 * - it clears the history, the way `removeAllActions` does, because it can't
 *   be undone (deleting books, adding books, a library switch…).
 * Clearing is what keeps Undo honest: without it, Undo would offer to undo
 * something older across a change it can't see, against a library that has
 * moved on. A new action picks a side deliberately; doing neither is a bug.
 */
export interface UndoEntry {
	/** The action's name as the menu shows it after "Undo": "Mark as Finished". */
	readonly name: string;
	undo(): Promise<void>;
	redo(): Promise<void>;
}

export interface UndoHistory {
	/** Oldest first; the last entry is what Undo undoes. */
	readonly undo: readonly UndoEntry[];
	/** Oldest first; the last entry is what Redo redoes. */
	readonly redo: readonly UndoEntry[];
}

/** How many steps Undo can go back, as NSUndoManager's levelsOfUndo. */
export const UNDO_LIMIT = 50;

export const emptyUndoHistory: UndoHistory = { undo: [], redo: [] };

/** A new action: it goes on top, and whatever Redo had is gone. */
export const registerEntry = (
	history: UndoHistory,
	entry: UndoEntry,
): UndoHistory => ({
	undo: [...history.undo, entry].slice(-UNDO_LIMIT),
	redo: [],
});

export interface UndoStep {
	entry: UndoEntry;
	/** The history once the step has run. */
	history: UndoHistory;
}

/** The entry Undo runs, and the history after it (the entry moves to Redo). */
export const undoStep = (history: UndoHistory): Option<UndoStep> => {
	const entry = history.undo.at(-1);
	if (entry === undefined) return none();
	return some({
		entry,
		history: {
			undo: history.undo.slice(0, -1),
			redo: [...history.redo, entry],
		},
	});
};

/** The entry Redo runs, and the history after it (the entry moves to Undo). */
export const redoStep = (history: UndoHistory): Option<UndoStep> => {
	const entry = history.redo.at(-1);
	if (entry === undefined) return none();
	return some({
		entry,
		history: {
			undo: [...history.undo, entry],
			redo: history.redo.slice(0, -1),
		},
	});
};

/** "Undo Mark as Finished", or null when there is nothing to undo. */
export const undoTitle = (history: UndoHistory): string | null => {
	const entry = history.undo.at(-1);
	return entry === undefined ? null : `Undo ${entry.name}`;
};

/** "Redo Mark as Finished", or null when there is nothing to redo. */
export const redoTitle = (history: UndoHistory): string | null => {
	const entry = history.redo.at(-1);
	return entry === undefined ? null : `Redo ${entry.name}`;
};

/**
 * Mark as Finished / Unfinished as an undo entry over the books it changed,
 * which were all the other way before: Undo flips them back, Redo sets them
 * again. `apply` writes the flag for a set of books.
 */
export const finishedEntry = (
	ids: readonly string[],
	finished: boolean,
	apply: (ids: readonly string[], finished: boolean) => Promise<void>,
): UndoEntry => ({
	name: finished ? "Mark as Finished" : "Mark as Unfinished",
	undo: () => apply(ids, !finished),
	redo: () => apply(ids, finished),
});

/** The direction of a step of an undo entry: Undo or Redo. */
export type EditDirection = "undo" | "redo";

/**
 * Edit N Books as an undo entry over the books that the edit changed. The
 * server gives `undoEdits`, with one edit for each book that it changed, so
 * the name counts them. Undo sends the undo edits and Redo sends `forward`.
 * Both are edits, and an edit is a patch, so each applies to the current
 * state of each book. Redo can change other values than the first save, so
 * the entry keeps the undo edits that the server returns for the Redo, and
 * the next Undo sends them. A failure calls `onFailure`, so that the caller
 * can show a banner, and then throws the error again.
 */
export const editBooksEntry = (
	forward: readonly BookEdit[],
	undoEdits: readonly BookEdit[],
	apply: (edits: readonly BookEdit[]) => Promise<EditBooksOutcome>,
	onFailure: (direction: EditDirection, error: unknown) => void,
): UndoEntry => {
	let currentUndo = undoEdits;
	const run = async (
		direction: EditDirection,
		edits: readonly BookEdit[],
	): Promise<EditBooksOutcome> => {
		try {
			return await apply(edits);
		} catch (error) {
			onFailure(direction, error);
			throw error;
		}
	};
	return {
		name: `Edit ${booksTitle(undoEdits.length)}`,
		undo: async () => {
			await run("undo", currentUndo);
		},
		redo: async () => {
			currentUndo = (await run("redo", forward)).undo;
		},
	};
};
