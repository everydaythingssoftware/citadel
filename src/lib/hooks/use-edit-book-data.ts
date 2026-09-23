import { useCallback, useEffect, useState } from "react";

import type { LibraryBook } from "@/bindings";
import { sortedTagNames } from "@/lib/domain/tag";
import { useLibraryReady, useLibraryStore } from "@/stores/library/store";

export interface EditBookData {
	/** The book being edited; null while loading or when not found. */
	book: LibraryBook | null;
	/** Full tag vocabulary for the tag autocomplete, locale-sorted. */
	allTagList: string[];
	/** True during the initial fetch for a bookId; refreshes stay quiet. */
	loading: boolean;
	error: string | null;
	/**
	 * Re-fetch only this book (after a save or identifier change). The
	 * stale form stays on screen instead of flashing a spinner.
	 */
	refreshBook: () => Promise<void>;
	/**
	 * Show a copy the caller already has (e.g. the one a save returned),
	 * skipping the refetch. Ignored if the route has moved to another book.
	 */
	replaceBook: (book: LibraryBook) => void;
	/** Re-fetch the tag vocabulary (after a save that changed tags). */
	refreshTags: () => Promise<void>;
}

/**
 * The edit route's scoped data: exactly its own book (clb_query_get_book)
 * and the library's tag vocabulary (clb_query_list_tags). Saves invalidate
 * the paged grid cache through the store; this hook never triggers — and the
 * route never pays for — a whole-library fetch.
 */
export const useEditBookData = (bookId: string): EditBookData => {
	const library = useLibraryStore((state) => state.library);
	const ready = useLibraryReady();

	const [book, setBook] = useState<LibraryBook | null>(null);
	const [allTagList, setAllTagList] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refreshBook = useCallback(async () => {
		if (!library) return;
		setBook(await library.getBook(bookId));
	}, [library, bookId]);

	const replaceBook = useCallback((next: LibraryBook) => {
		setBook((current) => (current?.id === next.id ? next : current));
	}, []);

	const refreshTags = useCallback(async () => {
		if (!library) return;
		setAllTagList(sortedTagNames(await library.listTags()));
	}, [library]);

	useEffect(() => {
		if (!ready || !library) return;

		let cancelled = false;
		setLoading(true);
		setError(null);
		// Navigating to a different book: drop the previous one immediately
		// so its form never renders against the new id.
		setBook(null);

		void (async () => {
			try {
				const [nextBook, tags] = await Promise.all([
					library.getBook(bookId),
					library.listTags(),
				]);
				if (cancelled) return;
				setBook(nextBook);
				setAllTagList(sortedTagNames(tags));
			} catch (fetchError) {
				if (cancelled) return;
				setError(
					fetchError instanceof Error ? fetchError.message : String(fetchError),
				);
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [ready, library, bookId]);

	return {
		book,
		allTagList,
		loading,
		error,
		refreshBook,
		replaceBook,
		refreshTags,
	};
};
