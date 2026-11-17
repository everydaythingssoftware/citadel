import { useChooseBookFiles } from "@/lib/hooks/use-choose-book-files";
import {
	LibraryState,
	useLibraryState,
	useLibraryStore,
} from "@/stores/library/store";

interface AddBook {
	/**
	 * Opens the file chooser and queues the chosen books for review in the
	 * add-books sheet (see BookUploads).
	 */
	startAddBook: () => void;
	/** True when the library is ready and can take a new book from here. */
	canAddBook: boolean;
}

/**
 * Starts the add-books flow from any control: the toolbar button, an
 * empty-state prompt, Library > Add Book….
 */
export const useAddBook = (): AddBook => {
	const state = useLibraryState();
	const takesBooks = useLibraryStore(
		(state) => state.library?.uploads !== undefined,
	);
	const chooseBooks = useChooseBookFiles();
	const canAddBook = state === LibraryState.ready && takesBooks;
	return {
		startAddBook: () => {
			if (canAddBook) chooseBooks();
		},
		canAddBook,
	};
};
