/**
 * Pure logic for the library's paged book cache (stores/library/store.ts).
 *
 * The cover grid no longer holds every book in memory: it keeps one cache
 * entry per filter combination (the serialized cache key) holding the total
 * match count plus a sparse map of fetched pages. Everything here is plain
 * data-in/data-out so it can be unit-tested without Tauri.
 */

import type { BookSortOrder, LibraryBook, LibraryBookQuery } from "@/bindings";
import type { LibraryBookSortOrderKey } from "@/lib/platform/settings/types";

/**
 * Books fetched per page. 100 covers is 10–25 virtualized shelf rows
 * (4–10 columns per row), i.e. several viewports of scrolling per fetch,
 * while one page of fully hydrated books stays a small IPC payload.
 */
export const BOOK_PAGE_SIZE = 100;

/** The grid's filter state; one cache key per distinct combination. */
export interface BookGridFilter {
	/** Raw search text (debounced upstream); trimmed for the query/key. */
	text: string;
	authorId: string | null;
	seriesId: number | null;
	hideRead: boolean;
	sortOrder: LibraryBookSortOrderKey;
}

export const ALL_BOOKS_FILTER: BookGridFilter = {
	text: "",
	authorId: null,
	seriesId: null,
	hideRead: false,
	sortOrder: "authorAz",
};

const SORT_ORDER_TO_BACKEND: Record<LibraryBookSortOrderKey, BookSortOrder> = {
	nameAz: "TitleAsc",
	nameZa: "TitleDesc",
	authorAz: "AuthorAsc",
	authorZa: "AuthorDesc",
};

const normalizedText = (filter: BookGridFilter): string | null => {
	const trimmed = filter.text.trim();
	return trimmed.length > 0 ? trimmed : null;
};

/**
 * Cache key for a filter combination. Sorting is part of the key: a page
 * fetched under one sort order holds different indices under another.
 */
export const serializeBookFilter = (filter: BookGridFilter): string =>
	JSON.stringify([
		normalizedText(filter),
		filter.authorId,
		filter.seriesId,
		filter.hideRead,
		filter.sortOrder,
	]);

/**
 * The backend query for one page of a filter.
 *
 * Series filters are special-cased to a single unbounded page: books in a
 * series read in series order, but the backend only sorts by title/author
 * (Calibre sort columns), so the whole series is fetched at once and sorted
 * by `series_index` client-side. Series are small (rarely more than a few
 * dozen books), so this stays cheap.
 */
export const toBookQuery = (
	filter: BookGridFilter,
	pageIndex: number,
	pageSize: number = BOOK_PAGE_SIZE,
): LibraryBookQuery => ({
	text: normalizedText(filter),
	author_id: filter.authorId,
	series_id: filter.seriesId,
	hide_read: filter.hideRead,
	sort: SORT_ORDER_TO_BACKEND[filter.sortOrder],
	limit: filter.seriesId !== null ? null : pageSize,
	offset: filter.seriesId !== null ? 0 : pageIndex * pageSize,
});

/**
 * Page indices covering the inclusive item-index range [start, end].
 * The range is clamped to [0, total) when the total is known; an unknown
 * total (nothing fetched yet) clamps nothing so page 0 can be requested.
 */
export const pagesCoveringRange = (
	start: number,
	end: number,
	pageSize: number = BOOK_PAGE_SIZE,
	total: number | null = null,
): number[] => {
	const clampedStart = Math.max(start, 0);
	const clampedEnd = total === null ? end : Math.min(end, total - 1);
	if (clampedEnd < clampedStart) return [];

	const firstPage = Math.floor(clampedStart / pageSize);
	const lastPage = Math.floor(clampedEnd / pageSize);
	const pages: number[] = [];
	for (let page = firstPage; page <= lastPage; page++) {
		pages.push(page);
	}
	return pages;
};

/** One filter combination's pages. */
export interface PagedBookCache {
	/** Serialized [`BookGridFilter`] the pages belong to. */
	key: string;
	/**
	 * Monotonic stamp. Fetch results may only land while the generation they
	 * started under is still current; mutations bump it to drop stale pages.
	 */
	generation: number;
	/** Total matches for the filter; null until the first page lands. */
	total: number | null;
	/** Sparse page-index → fetched books. */
	pages: ReadonlyMap<number, LibraryBook[]>;
}

export const emptyBookCache = (
	key: string,
	generation: number,
): PagedBookCache => ({
	key,
	generation,
	total: null,
	pages: new Map(),
});

/**
 * The cache to use for a (possibly new) filter key: the same cache when the
 * key matches, otherwise a fresh empty cache under the next generation.
 */
export const cacheForKey = (
	cache: PagedBookCache,
	key: string,
): PagedBookCache =>
	cache.key === key ? cache : emptyBookCache(key, cache.generation + 1);

/**
 * Drops every fetched page and bumps the generation (cancelling in-flight
 * fetches), keeping the key and the last known total so the grid keeps its
 * height while visible pages refetch lazily. Used after mutations.
 */
export const invalidateBookCache = (cache: PagedBookCache): PagedBookCache => ({
	key: cache.key,
	generation: cache.generation + 1,
	total: cache.total,
	pages: new Map(),
});

export const findCachedBook = (
	cache: PagedBookCache,
	bookId: LibraryBook["id"],
): LibraryBook | undefined => {
	for (const pageItems of cache.pages.values()) {
		const found = pageItems.find((item) => item.id === bookId);
		if (found) return found;
	}
	return undefined;
};

const replaceById = <TItem extends LibraryBook | undefined>(
	items: readonly TItem[],
	book: LibraryBook,
): TItem[] | null => {
	const index = items.findIndex((item) => item?.id === book.id);
	if (index === -1) return null;
	const next = [...items];
	next[index] = book as TItem;
	return next;
};

/**
 * Swaps one book's cached copy for `book` wherever it is loaded, keeping the
 * key, generation, and total. Only valid when the change cannot move the
 * book (see [`bookPlacementChanged`]); returns the same cache if it is not
 * loaded.
 */
export const replaceBookInCache = (
	cache: PagedBookCache,
	book: LibraryBook,
): PagedBookCache => {
	for (const [pageIndex, pageItems] of cache.pages) {
		const replaced = replaceById(pageItems, book);
		if (replaced === null) continue;
		const pages = new Map(cache.pages);
		pages.set(pageIndex, replaced);
		return { ...cache, pages };
	}
	return cache;
};

export const replaceBookInSnapshot = (
	snapshot: BookSnapshot | null,
	book: LibraryBook,
): BookSnapshot | null => {
	if (snapshot === null) return null;
	const replaced = replaceById(snapshot.items, book);
	return replaced === null ? snapshot : { ...snapshot, items: replaced };
};

const primaryAuthorId = (book: LibraryBook): string | undefined =>
	book.author_list[0]?.id;

const authorIdsKey = (book: LibraryBook): string =>
	book.author_list.map((author) => author.id).join(",");

/**
 * Whether going from `before` to `after` can change the book's position or
 * membership under `filter`, mirroring the backend's WHERE/ORDER BY (sorts
 * tie-break on id, so only the sort column itself moves a book). When true,
 * an in-place patch would leave the grid misordered and pages must refetch.
 */
export const bookPlacementChanged = (
	before: LibraryBook,
	after: LibraryBook,
	filter: BookGridFilter,
): boolean => {
	const hasText = normalizedText(filter) !== null;
	const titleSort =
		filter.sortOrder === "nameAz" || filter.sortOrder === "nameZa";
	const authorSort = !titleSort;

	const titleChanged =
		before.title !== after.title ||
		before.sortable_title !== after.sortable_title;
	const authorsChanged = authorIdsKey(before) !== authorIdsKey(after);
	const primaryAuthorChanged =
		primaryAuthorId(before) !== primaryAuthorId(after);
	const seriesChanged = before.series !== after.series;
	const seriesIndexChanged = before.series_index !== after.series_index;

	if (titleChanged && (titleSort || hasText || filter.seriesId !== null)) {
		return true;
	}
	if (primaryAuthorChanged && authorSort) return true;
	if (authorsChanged && (hasText || filter.authorId !== null)) return true;
	if (seriesChanged && (hasText || filter.seriesId !== null)) return true;
	if (seriesIndexChanged && filter.seriesId !== null) return true;
	if (before.is_read !== after.is_read && filter.hideRead) return true;
	return false;
};

export interface FetchedBookPage {
	key: string;
	generation: number;
	pageIndex: number;
	items: LibraryBook[];
	total: number;
}

/**
 * Lands one fetched page. Results from a superseded key or generation are
 * dropped (the cache is returned unchanged).
 */
export const applyBookPage = (
	cache: PagedBookCache,
	fetched: FetchedBookPage,
): PagedBookCache => {
	if (fetched.key !== cache.key || fetched.generation !== cache.generation) {
		return cache;
	}
	const pages = new Map(cache.pages);
	pages.set(fetched.pageIndex, fetched.items);
	return { ...cache, total: fetched.total, pages };
};

/**
 * A frozen view of the last successfully resolved query: the flattened book
 * list and the total it reported. Used for stale-while-revalidate rendering
 * so the grid never blanks between keystrokes.
 */
export interface BookSnapshot {
	/** Serialized filter key the snapshot belongs to. */
	key: string;
	items: (LibraryBook | undefined)[];
	total: number;
}

/**
 * Returns an updated snapshot if the cache has resolved data worth
 * preserving (non-null total), otherwise returns the existing snapshot
 * unchanged. Call this after every `applyBookPage`.
 *
 * When the cache has `total === null` (new key not yet fetched), the previous
 * snapshot is returned as-is so the grid can keep showing stale results.
 */
export const advanceSnapshot = (
	cache: PagedBookCache,
	current: BookSnapshot | null,
): BookSnapshot | null => {
	if (cache.total === null) return current;
	return { key: cache.key, items: sparseBookItems(cache), total: cache.total };
};

/**
 * The cache flattened to the grid's indexed-array shape: length `total`,
 * `undefined` holes where pages have not been fetched.
 */
export const sparseBookItems = (
	cache: PagedBookCache,
	pageSize: number = BOOK_PAGE_SIZE,
): (LibraryBook | undefined)[] => {
	const total = cache.total ?? 0;
	const items = new Array<LibraryBook | undefined>(total).fill(undefined);
	for (const [pageIndex, pageItems] of cache.pages) {
		const offset = pageIndex * pageSize;
		for (let i = 0; i < pageItems.length; i++) {
			const index = offset + i;
			if (index >= total) break;
			items[index] = pageItems[i];
		}
	}
	return items;
};

/** Series-order comparator (used when a series filter is active). */
export const compareBySeriesIndex = (
	a: LibraryBook,
	b: LibraryBook,
): number => {
	const indexA = a.series_index ?? Number.POSITIVE_INFINITY;
	const indexB = b.series_index ?? Number.POSITIVE_INFINITY;
	if (indexA !== indexB) return indexA - indexB;
	return a.title.localeCompare(b.title);
};
