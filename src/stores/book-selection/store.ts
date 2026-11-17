import { create } from "zustand";
import type { LibraryBook } from "@/bindings";
import {
	type BookSelection,
	emptySelection,
	type ParkedSelection,
	type SelectionAndDetails,
	withoutBooks,
} from "@/lib/book-selection";

interface BookSelectionState extends SelectionAndDetails {
	/**
	 * The selection and details the grid had when its page was left, for
	 * coming Back to it. Not the live selection: the menus see none while
	 * the grid isn't showing.
	 */
	parked: ParkedSelection | null;
}

/**
 * The library grid's selection and the book its details show, outside
 * React so the menu bar acts on the same selection the grid shows.
 * `detailsBook` stays while the drawer slides closed.
 */
export const useBookSelectionStore = create<BookSelectionState>(() => ({
	selection: emptySelection,
	detailsBook: null,
	detailsOpen: false,
	parked: null,
}));

export const updateBookSelection = (
	update: (selection: BookSelection) => BookSelection,
) => {
	useBookSelectionStore.setState((state) => {
		const selection = update(state.selection);
		return selection === state.selection ? state : { selection };
	});
};

export const openBookDetails = (book: LibraryBook) =>
	useBookSelectionStore.setState({ detailsBook: book, detailsOpen: true });

export const closeBookDetails = () =>
	useBookSelectionStore.setState({ detailsOpen: false });

/** The open details follow the keyboard onto another book. */
export const followWithDetails = (book: LibraryBook) => {
	const { detailsOpen, detailsBook } = useBookSelectionStore.getState();
	if (detailsOpen && detailsBook?.id !== book.id)
		useBookSelectionStore.setState({ detailsBook: book });
};

/** Deleted books leave the selection and details, live and parked alike. */
export const forgetDeletedBooks = (ids: readonly LibraryBook["id"][]) =>
	useBookSelectionStore.setState((state) => ({
		...withoutBooks(state, ids),
		parked: state.parked === null ? null : withoutBooks(state.parked, ids),
	}));
