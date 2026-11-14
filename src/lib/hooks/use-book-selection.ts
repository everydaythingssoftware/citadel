import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { LibraryBook } from "@/bindings";
import { safeAsyncEventHandler } from "@/lib/async";
import { sparseBookItems } from "@/lib/book-page-cache";
import { primaryLocalPath, primaryRemoteFile } from "@/lib/book-files";
import {
	type BookMenuContext,
	BOOK_COMMAND,
	type TBookCommand,
} from "@/lib/book-menu";
import {
	type BookSelection,
	clearSelection,
	emptySelection,
	isBookSelected,
	materializePending,
	selectAll,
	selectedBookCount,
	selectedBooks,
	unresolvedRange,
} from "@/lib/book-selection";
import { downloadFile } from "@/lib/download";
import { usePlatform } from "@/lib/platform/context";
import type { PlatformAdapter } from "@/lib/platform/types";
import { BookDeletion, type TBookDeletion } from "@/lib/services/library";
import { type FinishedChange, finishedEntry } from "@/lib/undo-history";
import { useLibraryStore } from "@/stores/library/store";
import { useLibraryView } from "@/stores/library-view/store";
import { registerUndo } from "@/stores/undo/store";

interface DeleteRequest {
	books: LibraryBook[];
}

interface BookSelectionStore {
	selection: BookSelection;
	/** The book the details drawer shows, kept while it slides closed. */
	detailsBook: LibraryBook | null;
	detailsOpen: boolean;
	/** The books the delete confirmation names, kept while it fades out. */
	deleteRequest: DeleteRequest | null;
	deleteDialogOpen: boolean;
	deleting: boolean;
	/** Files a finished delete couldn't remove, shown until dismissed. */
	deleteFailures: string[] | null;
	deleteError: string | null;
}

/**
 * The library grid's selection and the dialogs it drives, outside React so
 * the menu bar's commands (wired elsewhere) act on the same selection the
 * grid shows.
 */
export const useBookSelectionStore = create<BookSelectionStore>(() => ({
	selection: emptySelection,
	detailsBook: null,
	detailsOpen: false,
	deleteRequest: null,
	deleteDialogOpen: false,
	deleting: false,
	deleteFailures: null,
	deleteError: null,
}));

export const updateBookSelection = (
	update: (selection: BookSelection) => BookSelection,
) => {
	useBookSelectionStore.setState((state) => {
		const selection = update(state.selection);
		return selection === state.selection ? state : { selection };
	});
};

const currentItems = () =>
	sparseBookItems(useLibraryStore.getState().bookCache);
const currentTotal = () => useLibraryStore.getState().bookCache.total ?? 0;

/**
 * Every selected book, fetching the pages Select All or a long ⇧-range
 * covers but the grid never loaded.
 */
export const resolveSelectedBooks = async (): Promise<LibraryBook[]> => {
	const range = unresolvedRange(
		useBookSelectionStore.getState().selection,
		currentTotal(),
	);
	if (range !== null)
		await useLibraryStore
			.getState()
			.actions.ensureBookRange(range.start, range.end);
	const { selection } = useBookSelectionStore.getState();
	return selectedBooks(
		materializePending(selection, currentItems()),
		currentItems(),
	);
};

export const openBookDetails = (book: LibraryBook) =>
	useBookSelectionStore.setState({ detailsBook: book, detailsOpen: true });

/** The open details follow the keyboard onto another book. */
export const followWithDetails = (book: LibraryBook) => {
	const { detailsOpen, detailsBook } = useBookSelectionStore.getState();
	if (detailsOpen && detailsBook?.id !== book.id)
		useBookSelectionStore.setState({ detailsBook: book });
};

/**
 * A double-click: the book's preferred file opens in its default app on
 * the desktop, or downloads in the browser.
 */
export const openBookFile = (
	book: LibraryBook,
	{
		capabilities,
		fileOpener,
	}: Pick<PlatformAdapter, "capabilities" | "fileOpener">,
) => {
	if (capabilities.canOpenLocalPaths) {
		const path = primaryLocalPath(book);
		if (path !== null)
			fileOpener
				.openPath(path)
				.catch((error: unknown) => console.error("Open book:", error));
		return;
	}
	const file = primaryRemoteFile(book);
	if (file !== null) downloadFile(file.url);
};

export const closeBookDetails = () =>
	useBookSelectionStore.setState({ detailsOpen: false });

/**
 * Keeps the selection in step with the grid: empties it when the result
 * set changes (new filter or library) and names pending books as their
 * pages arrive.
 */
export const useBookSelectionSync = ({
	books,
	resetKey,
}: {
	books: readonly (LibraryBook | undefined)[];
	resetKey: string;
}) => {
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey exists solely to trigger this reset.
	useEffect(() => {
		useBookSelectionStore.setState({ selection: emptySelection });
	}, [resetKey]);

	useEffect(() => {
		updateBookSelection((selection) => materializePending(selection, books));
	}, [books]);

	useEffect(
		() => () => {
			useBookSelectionStore.setState({
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
	const total = useLibraryStore((state) => state.bookCache.total ?? 0);
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

export interface BookSelectionActions {
	/** Books the next action applies to; Select All counts unfetched ones. */
	selectedCount: number;
	/** Every loaded selected book is finished: offer "Mark as Unfinished". */
	allFinished: boolean;
	/** What the menus may offer here, for `bookMenuEntries`. */
	menuContext: BookMenuContext;
	showDetails(): void;
	open(): void;
	edit(): void;
	quickLook(): void;
	toggleFinished(): void;
	showInFileManager(): void;
	copyTitle(): void;
	download(): void;
	requestDelete(): void;
	selectAll(): void;
	clearSelection(): void;
	/** Runs a book menu item by its id (context menu and menu bar alike). */
	run(command: TBookCommand): void;
}

interface BookMenuContextInput {
	selection: BookSelection;
	books: readonly (LibraryBook | undefined)[];
	total: number;
	/** Unread Only is on: nothing shown can be finished. */
	hideRead: boolean;
	canEdit: boolean;
	platform: PlatformAdapter;
}

/** What the book menus may offer for this selection on this platform. */
export const bookMenuContext = ({
	selection,
	books,
	total,
	hideRead,
	canEdit,
	platform: { capabilities, fileOpener },
}: BookMenuContextInput): BookMenuContext => {
	const selectedCount = selectedBookCount(selection, total);
	const loaded =
		hideRead || selectedCount === 0 ? [] : selectedBooks(selection, books);
	return {
		selectedCount,
		allFinished: loaded.length > 0 && loaded.every((book) => book.is_read),
		canOpen: capabilities.canOpenLocalPaths,
		canEdit,
		canQuickLook: capabilities.canQuickLook,
		canShowInFileManager: capabilities.canRevealInFileManager,
		fileManagerName: fileOpener.fileManagerName,
		canCopyTitle: capabilities.canCopyToClipboard,
		canDownload: !capabilities.canOpenLocalPaths,
	};
};

const fullUpdate = (isRead: boolean) => ({
	author_id_list: null,
	tag_list: null,
	title: null,
	timestamp: null,
	publication_date: null,
	is_read: isRead,
	description: null,
	series: null,
	series_index: null,
	language_list: null,
});

/**
 * What can be done with the selected books, for the right-click menu and
 * the Book menu. Every action resolves the selection when it runs, so
 * Select All acts on books whose pages were never fetched.
 */
export const useBookSelectionActions = (): BookSelectionActions => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const selection = useBookSelectionStore((state) => state.selection);
	const cache = useLibraryStore((state) => state.bookCache);
	const canEdit = useLibraryStore((state) => state.library?.readOnly === false);
	const hideRead = useLibraryView((state) => state.hideRead);

	const menuContext = useMemo(
		() =>
			bookMenuContext({
				selection,
				books: sparseBookItems(cache),
				total: cache.total ?? 0,
				hideRead,
				canEdit,
				platform,
			}),
		[selection, cache, hideRead, canEdit, platform],
	);
	const { selectedCount, allFinished } = menuContext;
	const { fileOpener } = platform;

	const withBooks = (action: (books: LibraryBook[]) => unknown) =>
		safeAsyncEventHandler(async () => {
			const books = await resolveSelectedBooks();
			if (books.length > 0) await action(books);
		});

	const first = (action: (book: LibraryBook) => unknown) =>
		withBooks((books) => {
			const [book] = books;
			if (book !== undefined) return action(book);
		});

	const showDetails = first(openBookDetails);
	const open = withBooks(async (books) => {
		for (const path of books.map(primaryLocalPath))
			if (path !== null) await fileOpener.openPath(path);
	});
	const edit = first((book) =>
		navigate({ to: "/books/$bookId", params: { bookId: book.id } }),
	);
	const quickLook = first((book) => {
		const path = primaryLocalPath(book);
		if (path !== null && fileOpener.quickLook)
			return fileOpener.quickLook(path);
	});
	const toggleFinished = withBooks(async (books) => {
		const finished = !books.every((book) => book.is_read);
		const { actions } = useLibraryStore.getState();
		const setFinished = (id: string, isRead: boolean) =>
			actions.updateBook(id, fullUpdate(isRead), { registersUndo: true });
		const changed: FinishedChange[] = [];
		try {
			for (const book of books) {
				if (book.is_read === finished) continue;
				await setFinished(book.id, finished);
				changed.push({ id: book.id, wasFinished: book.is_read });
			}
		} finally {
			if (changed.length > 0)
				registerUndo(finishedEntry(changed, finished, setFinished));
		}
		if (finished && useLibraryView.getState().hideRead)
			updateBookSelection(clearSelection);
	});
	const showInFileManager = first((book) => {
		const path = primaryLocalPath(book);
		if (path !== null) return fileOpener.revealInFileManager(path);
	});
	const copyTitle = withBooks((books) =>
		platform.clipboard.writeText(books.map((book) => book.title).join("\n")),
	);
	const download = first((book) => {
		const file = primaryRemoteFile(book);
		if (file !== null) downloadFile(file.url);
	});
	const requestDelete = withBooks((books) => {
		useBookSelectionStore.setState({
			deleteRequest: { books },
			deleteDialogOpen: true,
		});
	});

	const handlers: Record<TBookCommand, () => void> = {
		[BOOK_COMMAND.showDetails]: showDetails,
		[BOOK_COMMAND.open]: open,
		[BOOK_COMMAND.edit]: edit,
		[BOOK_COMMAND.quickLook]: quickLook,
		[BOOK_COMMAND.toggleFinished]: toggleFinished,
		[BOOK_COMMAND.showInFileManager]: showInFileManager,
		[BOOK_COMMAND.copyTitle]: copyTitle,
		[BOOK_COMMAND.download]: download,
		[BOOK_COMMAND.delete]: requestDelete,
	};

	return {
		selectedCount,
		allFinished,
		menuContext,
		showDetails,
		open,
		edit,
		quickLook,
		toggleFinished,
		showInFileManager,
		copyTitle,
		download,
		requestDelete,
		selectAll: () => updateBookSelection(selectAll),
		clearSelection: () => updateBookSelection(clearSelection),
		run: (command) => handlers[command](),
	};
};

/** The one confirmation a delete from the grid asks for (ADR 0014). */
export const useDeleteBooksDialog = () => {
	const request = useBookSelectionStore((state) => state.deleteRequest);
	const open = useBookSelectionStore((state) => state.deleteDialogOpen);
	const deleting = useBookSelectionStore((state) => state.deleting);
	const failures = useBookSelectionStore((state) => state.deleteFailures);
	const error = useBookSelectionStore((state) => state.deleteError);
	const deletion: TBookDeletion = useLibraryStore(
		(state) => state.library?.bookDeletion ?? BookDeletion.trash,
	);

	const confirm = async () => {
		if (request === null || useBookSelectionStore.getState().deleting) return;
		const ids = request.books.map((book) => book.id);
		useBookSelectionStore.setState({
			deleteDialogOpen: false,
			deleting: true,
			deleteError: null,
		});
		try {
			const outcome = await useLibraryStore.getState().actions.deleteBooks(ids);
			const { detailsBook } = useBookSelectionStore.getState();
			useBookSelectionStore.setState((state) => ({
				selection: clearSelection(state.selection),
				deleteFailures:
					outcome.folder_failures.length > 0 ? outcome.folder_failures : null,
				detailsOpen:
					detailsBook !== null && ids.includes(detailsBook.id)
						? false
						: state.detailsOpen,
			}));
		} catch (cause) {
			useBookSelectionStore.setState({
				deleteError: cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			useBookSelectionStore.setState({ deleting: false });
		}
	};

	return {
		open,
		books: request?.books ?? [],
		deletion,
		deleting,
		failures,
		error,
		confirm: () => void confirm(),
		cancel: () => useBookSelectionStore.setState({ deleteDialogOpen: false }),
		dismissFailures: () =>
			useBookSelectionStore.setState({
				deleteFailures: null,
				deleteError: null,
			}),
	};
};
