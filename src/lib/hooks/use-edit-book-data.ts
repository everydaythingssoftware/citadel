import { useCallback, useEffect, useState } from "react";

import type { LibraryBook } from "@/bindings";
import { sortedTagNames } from "@/lib/domain/tag";
import type { Library } from "@/lib/services/library";
import {
	LibraryState,
	useLibraryReady,
	useLibraryStore,
} from "@/stores/library/store";

/** What the route's loader fetched before the page was shown. */
export interface PreloadedEditBook {
	bookId: string;
	library: Library;
	book: LibraryBook;
	allTagList: string[];
}

/**
 * Fetches the page's data before the route commits, so the previous page
 * stays on screen until the book can be shown in full. Null when the
 * library isn't open yet or the fetch fails: the page then fetches (and
 * reports the error) itself.
 */
export const preloadEditBook = async (
	bookId: string,
): Promise<PreloadedEditBook | null> => {
	const { library, libraryState } = useLibraryStore.getState();
	if (!library || libraryState !== LibraryState.ready) return null;
	try {
		const [book, tags] = await Promise.all([
			library.getBook(bookId),
			library.listTags(),
		]);
		return { bookId, library, book, allTagList: sortedTagNames(tags) };
	} catch {
		return null;
	}
};

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
	/** Re-fetch the tag vocabulary (after a save that changed tags). */
	refreshTags: () => Promise<void>;
}

/**
 * The edit route's scoped data: exactly its own book (clb_query_get_book)
 * and the library's tag vocabulary (clb_query_list_tags). Saves invalidate
 * the paged grid cache through the store; this hook never triggers — and the
 * route never pays for — a whole-library fetch.
 */
export const useEditBookData = (
	bookId: string,
	preloaded: PreloadedEditBook | null,
): EditBookData => {
	const library = useLibraryStore((state) => state.library);
	const ready = useLibraryReady();
	const seed =
		preloaded?.bookId === bookId && preloaded.library === library
			? preloaded
			: null;

	const [book, setBook] = useState<LibraryBook | null>(seed?.book ?? null);
	const [allTagList, setAllTagList] = useState<string[]>(
		seed?.allTagList ?? [],
	);
	const [loading, setLoading] = useState(seed === null);
	const [error, setError] = useState<string | null>(null);

	const refreshBook = useCallback(async () => {
		if (!library) return;
		setBook(await library.getBook(bookId));
	}, [library, bookId]);

	const refreshTags = useCallback(async () => {
		if (!library) return;
		setAllTagList(sortedTagNames(await library.listTags()));
	}, [library]);

	useEffect(() => {
		if (seed) {
			setBook(seed.book);
			setAllTagList(seed.allTagList);
			setError(null);
			setLoading(false);
			return;
		}
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
	}, [seed, ready, library, bookId]);

	return { book, allTagList, loading, error, refreshBook, refreshTags };
};
