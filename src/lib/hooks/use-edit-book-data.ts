import { useCallback, useEffect, useState } from "react";

import type { BookCustomValue, CustomColumnDef, LibraryBook } from "@/bindings";
import { editableCustomColumns } from "@/lib/custom-columns";
import { sortedTagNames } from "@/lib/domain/tag";
import type { Library } from "@/lib/services/library";
import {
	LibraryState,
	useLibraryReady,
	useLibraryStore,
} from "@/stores/library/store";

export interface CoverSize {
	width: number;
	height: number;
}

/** The book's editable custom columns and their values. */
export interface PreloadedCustomFields {
	bookId: string;
	columns: CustomColumnDef[];
	values: BookCustomValue[];
}

/** What the route's loader fetched before the page was shown. */
export interface PreloadedEditBook {
	bookId: string;
	library: Library;
	book: LibraryBook;
	allTagList: string[];
	/** Null when they couldn't be read: the page loads them itself. */
	customFields: PreloadedCustomFields | null;
	/** The cover's real size, so its box is reserved before it paints. */
	coverSize: CoverSize | null;
}

/**
 * A cover on a slow connection shouldn't hold the page back for long; past
 * this, the page shows with the cover's box reserved from its thumbnail.
 */
const COVER_WAIT_MS = 1500;

const loadCoverSize = async (
	url: string | undefined,
): Promise<CoverSize | null> => {
	if (url === undefined) return null;
	const image = new Image();
	image.src = url;
	const timeout = new Promise<void>((resolve) =>
		setTimeout(resolve, COVER_WAIT_MS),
	);
	await Promise.race([image.decode().catch(() => undefined), timeout]);
	return image.naturalWidth > 0 && image.naturalHeight > 0
		? { width: image.naturalWidth, height: image.naturalHeight }
		: null;
};

const loadCustomFields = async (
	library: Library,
	bookId: string,
): Promise<PreloadedCustomFields | null> => {
	try {
		const columns = editableCustomColumns(await library.listCustomColumns());
		const values =
			columns.length > 0 ? await library.getCustomValuesForBook(bookId) : [];
		return { bookId, columns, values };
	} catch {
		return null;
	}
};

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
		const [customFields, coverSize] = await Promise.all([
			loadCustomFields(library, bookId),
			loadCoverSize(book.cover_image?.url),
		]);
		return {
			bookId,
			library,
			book,
			allTagList: sortedTagNames(tags),
			customFields,
			coverSize,
		};
	} catch {
		return null;
	}
};

export interface EditBookData {
	/** The book being edited; null while loading or when not found. */
	book: LibraryBook | null;
	/** Full tag vocabulary for the tag autocomplete, locale-sorted. */
	allTagList: string[];
	/** Custom fields the loader read with the book, if it did. */
	customFields: PreloadedCustomFields | null;
	/** The cover's real size, if the loader read it. */
	coverSize: CoverSize | null;
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

	return {
		book,
		allTagList,
		customFields: seed?.customFields ?? null,
		coverSize: seed?.coverSize ?? null,
		loading,
		error,
		refreshBook,
		refreshTags,
	};
};
