import { create } from "zustand";
import type { Option } from "@/lib/option";
import {
	emptyUndoHistory,
	redoStep,
	registerEntry,
	type UndoEntry,
	type UndoHistory,
	type UndoStep,
	undoStep,
} from "@/lib/undo-history";

interface UndoState {
	history: UndoHistory;
	/** An undo or redo is still writing: the next one waits its turn. */
	running: boolean;
}

/**
 * The library window's undo history (`src/lib/undo-history.ts` has the
 * rule every library change follows: register an entry or clear).
 */
export const useUndoStore = create<UndoState>(() => ({
	history: emptyUndoHistory,
	running: false,
}));

export const registerUndo = (entry: UndoEntry) =>
	useUndoStore.setState((state) => ({
		history: registerEntry(state.history, entry),
	}));

/** For a change that can't be undone: Undo must not reach back past it. */
export const clearUndoHistory = () => {
	if (useUndoStore.getState().history !== emptyUndoHistory)
		useUndoStore.setState({ history: emptyUndoHistory });
};

const run = async (
	step: (history: UndoHistory) => Option<UndoStep>,
	direction: "undo" | "redo",
): Promise<void> => {
	const { history, running } = useUndoStore.getState();
	if (running) return;
	const next = step(history);
	if (!next.isSome) return;
	useUndoStore.setState({ history: next.value.history, running: true });
	try {
		await next.value.entry[direction]();
	} catch (error) {
		// Half undone: the entries below no longer describe the library.
		useUndoStore.setState({ history: emptyUndoHistory });
		throw error;
	} finally {
		useUndoStore.setState({ running: false });
	}
};

export const undoLast = (): Promise<void> => run(undoStep, "undo");
export const redoLast = (): Promise<void> => run(redoStep, "redo");
