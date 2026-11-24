import { create } from "zustand";
import type { LibraryBook } from "@/bindings";
import { useLibraryStore } from "@/stores/library/store";

/**
 * An edit of several books from the grid. The sheet is open while the step
 * is "editing". `libraryPath` is the confirmed library when the edit began.
 */
export type EditBooksState =
	| { step: "idle" }
	| { step: "editing"; books: LibraryBook[]; libraryPath: string };

/** The request store of the sheet that edits several books. */
export const useEditBooksStore = create<EditBooksState>(() => ({
	step: "idle",
}));

/**
 * Opens the sheet for the books and records the confirmed library. With no
 * confirmed library, it changes nothing.
 */
export const requestBooksEdit = (books: LibraryBook[]) => {
	const libraryPath = useLibraryStore.getState().confirmedLibraryPath;
	if (libraryPath === null) return;
	useEditBooksStore.setState({ step: "editing", books, libraryPath }, true);
};

/** Closes the sheet. */
export const closeBooksEdit = () =>
	useEditBooksStore.setState({ step: "idle" }, true);

/**
 * Closes the sheet when the confirmed library is no longer the one it
 * edits.
 */
export const closeBooksEditForLibrary = (libraryPath: string | null) => {
	const state = useEditBooksStore.getState();
	if (state.step === "editing" && state.libraryPath !== libraryPath)
		closeBooksEdit();
};
