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
 *
 * Registered today: Mark as Finished / Mark as Unfinished. Everything else
 * that writes clears (`src/stores/undo/store.ts` has `clearUndoHistory`).
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
export const undoStep = (history: UndoHistory): UndoStep | null => {
	const entry = history.undo.at(-1);
	if (entry === undefined) return null;
	return {
		entry,
		history: {
			undo: history.undo.slice(0, -1),
			redo: [...history.redo, entry],
		},
	};
};

/** The entry Redo runs, and the history after it (the entry moves to Undo). */
export const redoStep = (history: UndoHistory): UndoStep | null => {
	const entry = history.redo.at(-1);
	if (entry === undefined) return null;
	return {
		entry,
		history: {
			undo: [...history.undo, entry],
			redo: history.redo.slice(0, -1),
		},
	};
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

export interface FinishedChange {
	id: string;
	/** Whether the book was finished before the change. */
	wasFinished: boolean;
}

/**
 * Mark as Finished / Unfinished as an undo entry: Undo puts each book back
 * as it was, Redo sets them all again. `apply` writes one book's flag.
 */
export const finishedEntry = (
	changes: readonly FinishedChange[],
	finished: boolean,
	apply: (id: string, finished: boolean) => Promise<void>,
): UndoEntry => ({
	name: finished ? "Mark as Finished" : "Mark as Unfinished",
	undo: async () => {
		for (const change of changes) await apply(change.id, change.wasFinished);
	},
	redo: async () => {
		for (const change of changes) await apply(change.id, finished);
	},
});
