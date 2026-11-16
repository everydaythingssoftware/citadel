import type { LibraryBook } from "./bindings";
import type { BookCardActions } from "./components/atoms/BookCard";

export interface BookView {
	loading: boolean;
	/**
	 * Indexed array of the filtered library: length is the total match
	 * count, `undefined` entries are books whose page has not been fetched
	 * yet (they render as placeholders).
	 */
	bookList: (LibraryBook | undefined)[];
	/** Press, right-click and drag on a cover (use-book-grid-interaction). */
	cardActions: BookCardActions;
	/** Membership in the selection, by id (and index, for pending slots). */
	isSelected: (bookId: LibraryBook["id"], index: number) => boolean;
}
