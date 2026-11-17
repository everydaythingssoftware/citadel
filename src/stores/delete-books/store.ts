import { create } from "zustand";
import type { LibraryBook } from "@/bindings";

export type DeleteBooksProblem =
	| { kind: "files"; paths: string[] }
	| { kind: "error"; message: string };

/**
 * A delete from the grid: the confirmation naming the books, then, if
 * files stayed behind or the delete failed, the report of what went wrong.
 */
export type DeleteBooksState =
	| { step: "idle" }
	| { step: "confirm"; books: LibraryBook[] }
	| { step: "problem"; count: number; problem: DeleteBooksProblem };

export const useDeleteBooksStore = create<DeleteBooksState>(() => ({
	step: "idle",
}));

export const setDeleteBooksState = (state: DeleteBooksState) =>
	useDeleteBooksStore.setState(state, true);

export const requestBooksDeletion = (books: LibraryBook[]) =>
	setDeleteBooksState({ step: "confirm", books });
