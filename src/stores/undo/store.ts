import { create } from "zustand";
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
	/** An undo or redo is writing; library writes it makes don't clear. */
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
	step: (history: UndoHistory) => UndoStep | null,
	direction: "undo" | "redo",
): Promise<void> => {
	const { history, running } = useUndoStore.getState();
	if (running) return;
	const next = step(history);
	if (next === null) return;
	useUndoStore.setState({ history: next.history, running: true });
	try {
		await next.entry[direction]();
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
