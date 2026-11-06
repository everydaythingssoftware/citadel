import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
} from "react";
import { Button } from "@/components/ui";
import { useChooseBookFiles } from "@/lib/hooks/use-choose-book-files";
import { usePlatform } from "@/lib/platform/context";
import {
	LibraryState,
	useLibraryState,
	useLibraryStore,
} from "@/stores/library/store";

interface AddBookContextValue {
	/**
	 * Opens the file chooser and queues the chosen books for review in the
	 * add-books sheet (see BookUploads).
	 */
	startAddBook: () => void;
	/** True when the library is ready and can take a new book from here. */
	canAddBook: boolean;
}

const AddBookContext = createContext<AddBookContextValue | null>(null);

/**
 * Exposes starting the add-books flow via {@link useAddBook} so any control
 * (the toolbar button, an empty-state prompt, File > Add Book…) can start it.
 */
export const AddBookProvider = ({ children }: { children: ReactNode }) => {
	const state = useLibraryState();
	const platform = usePlatform();
	const takesBooks = useLibraryStore(
		(state) => state.library?.uploads !== undefined,
	);
	const chooseBooks = useChooseBookFiles();
	const canAddBook = state === LibraryState.ready && takesBooks;

	const startAddBook = useCallback(() => {
		if (canAddBook) chooseBooks();
	}, [canAddBook, chooseBooks]);

	// File > Add Book… in the native menu emits this event to the main window
	// (see src-tauri/src/menu.rs); it triggers the same flow as the button.
	useEffect(() => {
		const unlisten = platform.menu.onAddBook(() => {
			startAddBook();
		});
		return () => {
			void unlisten.then((dispose) => dispose());
		};
	}, [startAddBook, platform]);

	const contextValue = useMemo<AddBookContextValue>(
		() => ({ startAddBook, canAddBook }),
		[startAddBook, canAddBook],
	);

	return (
		<AddBookContext.Provider value={contextValue}>
			{children}
		</AddBookContext.Provider>
	);
};

export const useAddBook = (): AddBookContextValue => {
	const context = useContext(AddBookContext);
	if (context === null) {
		throw new Error("useAddBook must be used within an AddBookProvider");
	}
	return context;
};

export const AddBookButton = () => {
	const { startAddBook, canAddBook } = useAddBook();

	if (!canAddBook) {
		return null;
	}

	return (
		<Button variant="default" aria-label="Add Book" onClick={startAddBook}>
			<svg
				width="13"
				height="13"
				viewBox="0 0 15 15"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M7.5 2v11M2 7.5h11"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round"
				/>
			</svg>
			Add Book…
		</Button>
	);
};
