import { useNavigate } from "@tanstack/react-router";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import type { LibraryBook } from "@/bindings";
import { safeAsyncEventHandler } from "@/lib/async";
import { primaryLocalPath, primaryRemoteFile } from "@/lib/book-files";
import {
	BOOK_COMMAND,
	type BookCommands,
	type BookMenuEntry,
	bookMenuEntries,
	type TBookCommand,
} from "@/lib/book-menu";
import { shownBookItems } from "@/lib/book-page-cache";
import {
	type BookSelection,
	clearSelection,
	emptySelection,
	type GridPlace,
	isBookSelected,
	materializePending,
	restorableSelection,
	selectedBookCount,
	selectedBooks,
	unresolvedRange,
} from "@/lib/book-selection";
import { downloadFile } from "@/lib/download";
import { usePlatform } from "@/lib/platform/context";
import type { PlatformAdapter } from "@/lib/platform/types";
import { finishedEntry } from "@/lib/undo-history";
import {
	openBookDetails,
	updateBookSelection,
	useBookSelectionStore,
} from "@/stores/book-selection/store";
import { requestBooksDeletion } from "@/stores/delete-books/store";
import { useLibraryStore } from "@/stores/library/store";
import { useLibraryView } from "@/stores/library-view/store";
import { registerUndo } from "@/stores/undo/store";

/** The books the grid shows, which the selection's indices refer to. */
export const currentShownBooks = () => {
	const { bookCache, staleBookSnapshot } = useLibraryStore.getState();
	return shownBookItems(bookCache, staleBookSnapshot);
};

/**
 * Every selected book, fetching the pages Select All or a long ⇧-range
 * covers but the grid never loaded.
 */
export const resolveSelectedBooks = async (): Promise<LibraryBook[]> => {
	const range = unresolvedRange(
		useBookSelectionStore.getState().selection,
		currentShownBooks().length,
	);
	if (range !== null)
		await useLibraryStore
			.getState()
			.actions.ensureBookRange(range.start, range.end);
	const books = currentShownBooks();
	const { selection } = useBookSelectionStore.getState();
	return selectedBooks(materializePending(selection, books), books);
};

/**
 * Keeps the selection in step with the grid: empties it when the result
 * set or the library changes and names pending books as their pages
 * arrive. Leaving the page parks the selection and the details (the live
 * selection empties, so the menus see none); coming Back to the same place
 * (`restorableSelection`) takes them up again.
 */
export const useBookSelectionSync = ({
	books,
	resetKey,
	viewKey,
	entryKey,
}: {
	books: readonly (LibraryBook | undefined)[];
	/** The result set the grid holds; a new one empties the selection. */
	resetKey: string;
	/** The result set the page asks for, which a parked selection must match. */
	viewKey: string;
	/** The history entry the page is showing. */
	entryKey: string;
}) => {
	const libraryPath = useLibraryStore((state) => state.confirmedLibraryPath);
	const placeRef = useRef<GridPlace>({ libraryPath, entryKey, viewKey });
	placeRef.current = { libraryPath, entryKey, viewKey };
	// What the grid came back to, which its result set may still be on its
	// way to: arriving there keeps the restored selection.
	const restoredRef = useRef<Pick<GridPlace, "libraryPath" | "viewKey"> | null>(
		null,
	);
	const mountedRef = useRef(false);

	useLayoutEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			const { parked } = useBookSelectionStore.getState();
			const restored = restorableSelection(parked, placeRef.current);
			restoredRef.current = restored;
			useBookSelectionStore.setState(
				restored === null
					? { parked: null, selection: emptySelection }
					: {
							parked: null,
							selection: restored.selection,
							detailsBook: restored.detailsBook,
							detailsOpen: restored.detailsOpen,
						},
			);
			return;
		}
		const restored = restoredRef.current;
		if (
			restored !== null &&
			restored.viewKey === resetKey &&
			restored.libraryPath === libraryPath
		)
			return;
		restoredRef.current = null;
		useBookSelectionStore.setState({ selection: emptySelection });
	}, [resetKey, libraryPath]);

	useEffect(() => {
		updateBookSelection((selection) => materializePending(selection, books));
	}, [books]);

	useLayoutEffect(
		() => () => {
			mountedRef.current = false;
			const { selection, detailsBook, detailsOpen } =
				useBookSelectionStore.getState();
			useBookSelectionStore.setState({
				parked: { ...placeRef.current, selection, detailsBook, detailsOpen },
				selection: emptySelection,
				detailsOpen: false,
			});
		},
		[],
	);
};

/** The selection as the grid draws it. */
export const useBookSelection = () => {
	const selection = useBookSelectionStore((state) => state.selection);
	const total = useLibraryStore(
		(state) => state.bookCache.total ?? state.staleBookSnapshot?.total ?? 0,
	);
	const isSelected = useCallback(
		(id: LibraryBook["id"], index?: number) =>
			isBookSelected(selection, id, index),
		[selection],
	);
	return {
		selection,
		selectedCount: selectedBookCount(selection, total),
		isSelected,
	};
};

interface SelectionSummary {
	/** Books the next action applies to; Select All counts unfetched ones. */
	selectedCount: number;
	/** Every loaded selected book is finished: offer "Mark as Unfinished". */
	allFinished: boolean;
}

const summarize = (
	selection: BookSelection,
	books: readonly (LibraryBook | undefined)[],
	/** Unread only is on: nothing shown can be finished. */
	hideRead: boolean,
): SelectionSummary => {
	const selectedCount = selectedBookCount(selection, books.length);
	const loaded =
		hideRead || selectedCount === 0 ? [] : selectedBooks(selection, books);
	return {
		selectedCount,
		allFinished: loaded.length > 0 && loaded.every((book) => book.is_read),
	};
};

const currentSummary = () =>
	summarize(
		useBookSelectionStore.getState().selection,
		currentShownBooks(),
		useLibraryView.getState().hideRead,
	);

const withBooks = (action: (books: LibraryBook[]) => unknown) =>
	safeAsyncEventHandler(async () => {
		const books = await resolveSelectedBooks();
		if (books.length > 0) await action(books);
	});

const withBook = (action: (book: LibraryBook) => unknown) =>
	withBooks(([book]) => (book !== undefined ? action(book) : undefined));

const withLocalPath = (action: (path: string) => Promise<void>) =>
	withBook((book) => {
		const path = primaryLocalPath(book);
		return path !== null ? action(path) : undefined;
	});

const toggleFinished = async (books: LibraryBook[]) => {
	const finished = !books.every((book) => book.is_read);
	const ids = books
		.filter((book) => book.is_read !== finished)
		.map((book) => book.id);
	const { setBooksRead } = useLibraryStore.getState().actions;
	try {
		await setBooksRead(ids, finished);
	} finally {
		if (ids.length > 0)
			registerUndo(finishedEntry(ids, finished, setBooksRead));
	}
	if (finished && useLibraryView.getState().hideRead)
		updateBookSelection(clearSelection);
};

interface BookCommandDeps {
	platform: PlatformAdapter;
	editBook: (book: LibraryBook) => void;
}

/**
 * The commands the current selection supports on this platform. Each one
 * resolves the selection when it runs, so Select All acts on books whose
 * pages were never fetched.
 */
const bookCommands = (
	{ platform, editBook }: BookCommandDeps,
	count: number,
): BookCommands => {
	if (count === 0) return {};
	const single = count === 1;
	const canEdit = useLibraryStore.getState().library?.readOnly === false;
	const { capabilities, fileOpener, clipboard } = platform;
	const desktop = capabilities.canOpenLocalPaths;
	const { quickLook } = fileOpener;
	return {
		...(single
			? { [BOOK_COMMAND.showDetails]: withBook(openBookDetails) }
			: {}),
		...(desktop
			? {
					[BOOK_COMMAND.open]: withBooks(async (books) => {
						for (const path of books.map(primaryLocalPath))
							if (path !== null) await fileOpener.openPath(path);
					}),
				}
			: {}),
		...(single && canEdit ? { [BOOK_COMMAND.edit]: withBook(editBook) } : {}),
		...(single && quickLook.isSome
			? { [BOOK_COMMAND.quickLook]: withLocalPath(quickLook.value) }
			: {}),
		...(canEdit
			? { [BOOK_COMMAND.toggleFinished]: withBooks(toggleFinished) }
			: {}),
		...(single && capabilities.canRevealInFileManager
			? {
					[BOOK_COMMAND.showInFileManager]: withLocalPath((path) =>
						fileOpener.revealInFileManager(path),
					),
				}
			: {}),
		...(capabilities.canCopyToClipboard
			? {
					[BOOK_COMMAND.copyTitle]: withBooks((books) =>
						clipboard.writeText(books.map((book) => book.title).join("\n")),
					),
				}
			: {}),
		...(single && !desktop
			? {
					[BOOK_COMMAND.download]: withBook((book) => {
						const file = primaryRemoteFile(book);
						if (file !== null) downloadFile(file.url);
					}),
				}
			: {}),
		...(canEdit
			? { [BOOK_COMMAND.delete]: withBooks(requestBooksDeletion) }
			: {}),
	};
};

export interface BookSelectionActions extends SelectionSummary {
	/** Runs a book command, if the selection supports it here. */
	run(command: TBookCommand): void;
	/** The right-click menu for the selection as it is now. */
	menuEntries(): BookMenuEntry[];
}

/** What can be done with the selected books, for the menus and the grid. */
export const useBookSelectionActions = (): BookSelectionActions => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const selection = useBookSelectionStore((state) => state.selection);
	const cache = useLibraryStore((state) => state.bookCache);
	const snapshot = useLibraryStore((state) => state.staleBookSnapshot);
	const hideRead = useLibraryView((state) => state.hideRead);

	const commands = useMemo(() => {
		const deps: BookCommandDeps = {
			platform,
			editBook: (book) =>
				void navigate({ to: "/books/$bookId", params: { bookId: book.id } }),
		};
		return {
			run: (command: TBookCommand) =>
				bookCommands(deps, currentSummary().selectedCount)[command]?.(),
			menuEntries: () => {
				const { selectedCount, allFinished } = currentSummary();
				return bookMenuEntries(bookCommands(deps, selectedCount), {
					count: selectedCount,
					allFinished,
					fileManagerName: platform.fileOpener.fileManagerName,
				});
			},
		};
	}, [platform, navigate]);
	const summary = useMemo(
		() => summarize(selection, shownBookItems(cache, snapshot), hideRead),
		[selection, cache, snapshot, hideRead],
	);
	return useMemo(() => ({ ...summary, ...commands }), [summary, commands]);
};

/**
 * The details drawer's book, at its latest copy while it is in the loaded
 * pages (marked finished from the grid, say).
 */
export const useBookDetails = (books: readonly (LibraryBook | undefined)[]) => {
	const open = useBookSelectionStore((state) => state.detailsOpen);
	const shown = useBookSelectionStore((state) => state.detailsBook);
	const book =
		shown === null
			? null
			: (books.find((candidate) => candidate?.id === shown.id) ?? shown);
	return { open, book };
};
