import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ImportableBookMetadata, NewAuthor } from "@/bindings";
import {
	AddBookForm,
	title as addBookFormTitle,
} from "@/components/molecules/AddBookForm";
import { Button, Sheet } from "@/components/ui";
import {
	applyMetadataToBook,
	type PendingMetadata,
	refreshCoverId,
} from "@/lib/metadata-import";
import type { Library } from "@/lib/services/library";
import { usePlatform } from "@/lib/platform/context";
import {
	LibraryState,
	useAuthors,
	useLibraryActions,
	useLibraryStore,
	useLibraryState,
} from "@/stores/library/store";
import { useResolvedProviderConfig } from "@/stores/settings/metadata-providers";

interface AddBookContextValue {
	/** Opens the native file picker and walks the import flow. */
	startAddBook: () => void;
	/** True when the library is ready and the platform can pick local files. */
	canAddBook: boolean;
}

const AddBookContext = createContext<AddBookContextValue | null>(null);

/**
 * Owns the add-book import flow (file picker → metadata → confirm sheet) and
 * exposes it via {@link useAddBook} so any control — the toolbar button, an
 * empty-state prompt — can start it without duplicating the flow.
 */
export const AddBookProvider = ({ children }: { children: ReactNode }) => {
	const state = useLibraryState();
	const actions = useLibraryActions();
	const authors = useAuthors();
	const platform = usePlatform();
	const getProviderConfig = useResolvedProviderConfig();
	const activeLibrary = useLibraryStore((state) => state.library);
	const importLibraryRef = useRef<Library | null>(null);

	const [metadata, setMetadata] = useState<ImportableBookMetadata | null>();
	// Incremented per picked file so AddBookForm (and its metadata lookup
	// state) remounts fresh for each import.
	const [importSession, setImportSession] = useState(0);
	const pendingMetadataRef = useRef<PendingMetadata | null>(null);
	// Set as soon as addBook succeeds so a retry after a failed metadata apply
	// reuses the created book instead of creating a duplicate.
	const createdBookIdRef = useRef<string | null>(null);
	const [isModalOpen, setIsModalOpen] = useState(false);
	// The control that opened the flow, so focus can return there on close. The
	// trigger may unmount before then (e.g. an empty-state button disappears
	// once the first book is added), so the restore is best-effort.
	const triggerRef = useRef<HTMLElement | null>(null);
	const openModal = useCallback(() => setIsModalOpen(true), []);
	const closeModal = useCallback(() => setIsModalOpen(false), []);

	const closeAddBookModal = useCallback(() => {
		pendingMetadataRef.current = null;
		closeModal();
	}, [closeModal]);

	const authorList = useMemo(
		() => authors.map((author) => author.name),
		[authors],
	);

	const onCreateAuthor = useCallback(
		async (newAuthorName: string) => {
			const newAuthor: NewAuthor = {
				name: newAuthorName,
				sortable_name: newAuthorName,
			};
			if (importLibraryRef.current !== useLibraryStore.getState().library)
				throw new Error("Library changed during import");
			await actions.createAuthors([newAuthor]);
		},
		[actions],
	);

	const canAddBook =
		state === LibraryState.ready &&
		activeLibrary?.readOnly === false &&
		platform.capabilities.canPickLocalFiles;

	const startAddBook = useCallback(() => {
		if (!canAddBook) return;

		triggerRef.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;

		const targetLibrary = useLibraryStore.getState().library;
		void (async () => {
			try {
				const extensions = await actions.listValidFileTypes();
				const filePath = await platform.dialogs.openFile({
					filters: [{ name: "Importable files", extensions }],
				});
				if (!filePath || useLibraryStore.getState().library !== targetLibrary)
					return;

				const importableMetadata =
					await actions.getImportableBookMetadata(filePath);
				if (useLibraryStore.getState().library !== targetLibrary) return;
				if (importableMetadata) {
					importLibraryRef.current = targetLibrary;
					pendingMetadataRef.current = null;
					createdBookIdRef.current = null;
					setImportSession((session) => session + 1);
					setMetadata(importableMetadata);
					openModal();
				}
			} catch (failure) {
				console.error("failed to import new book: ", failure);
			}
		})();
	}, [actions, canAddBook, openModal, platform]);

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

	useEffect(() => {
		if (
			importLibraryRef.current !== null &&
			importLibraryRef.current !== activeLibrary
		) {
			importLibraryRef.current = null;
			createdBookIdRef.current = null;
			pendingMetadataRef.current = null;
			setMetadata(null);
			closeModal();
		}
	}, [activeLibrary, closeModal]);

	const addBookByMetadataWithEffects = async (form: AddBookForm) => {
		if (!metadata || state !== LibraryState.ready) return;
		const targetLibrary = importLibraryRef.current;
		const assertLibrary = () => {
			if (
				targetLibrary === null ||
				useLibraryStore.getState().library !== targetLibrary
			)
				throw new Error("Library changed during import");
		};
		const pendingMetadata = pendingMetadataRef.current;
		const editedMetadata: ImportableBookMetadata = {
			...metadata,
			title: form.title,
			author_names: form.authorList,
			// The normalized ISBN from a provider wins over the file's identifier.
			identifier: pendingMetadata?.isbn ?? metadata.identifier,
		};
		try {
			assertLibrary();
			// If a previous attempt created the book but failed while applying
			// metadata, reuse that book on retry instead of creating a duplicate.
			let bookId = createdBookIdRef.current;
			if (!bookId) {
				bookId = (await actions.addBook(editedMetadata)) ?? null;
				assertLibrary();
				createdBookIdRef.current = bookId;
			}
			if (bookId && pendingMetadata) {
				await applyMetadataToBook(bookId, pendingMetadata, {
					upsertBookIdentifier: async (...args) => {
						assertLibrary();
						await actions.upsertBookIdentifier(...args);
					},
					updateBook: async (...args) => {
						assertLibrary();
						await actions.updateBook(...args);
					},
					setBookCoverFromMetadata: async (...args) => {
						assertLibrary();
						await actions.setBookCoverFromMetadata(...args);
					},
					refreshCoverId: (book) =>
						refreshCoverId(book, getProviderConfig(book.provider)),
				});
			}
			assertLibrary();
			createdBookIdRef.current = null;
			closeAddBookModal();
			setMetadata(null);
		} catch (error) {
			console.error("Failed to add book to database", error);
			// Re-throw so the failure surfaces via safeAsyncEventHandler upstream.
			throw error;
		}
	};

	const contextValue = useMemo<AddBookContextValue>(
		() => ({ startAddBook, canAddBook }),
		[startAddBook, canAddBook],
	);

	return (
		<AddBookContext.Provider value={contextValue}>
			{metadata && (
				// Compact sheet anchored under the toolbar (macOS document-sheet
				// feel): light dim, the library stays visible behind it.
				<Sheet
					open={isModalOpen}
					onOpenChange={(open) => {
						if (!open) closeAddBookModal();
					}}
					title={addBookFormTitle}
					width={480}
					onCloseAutoFocus={(event) => {
						// The sheet opens from a file-picker flow, not a Dialog.Trigger,
						// so return focus to whatever opened it ourselves.
						const trigger = triggerRef.current;
						if (trigger?.isConnected) {
							event.preventDefault();
							trigger.focus();
						}
					}}
				>
					<AddBookForm
						key={importSession}
						initial={{
							authorList: metadata?.author_names ?? [],
							title: metadata?.title ?? "",
						}}
						authorList={authorList}
						fileName={metadata?.path ?? ""}
						fileIdentifier={metadata.identifier}
						hideTitle={true}
						onCreateAuthor={onCreateAuthor}
						onSubmit={addBookByMetadataWithEffects}
						onCancel={closeAddBookModal}
						onPendingMetadataChange={(pending) => {
							pendingMetadataRef.current = pending;
						}}
					/>
				</Sheet>
			)}
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
		<Button
			variant="default"
			size="sm"
			aria-label="Add Book"
			onClick={startAddBook}
		>
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
