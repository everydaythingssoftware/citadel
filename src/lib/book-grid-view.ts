/**
 * What the book grid shows: its status, the callout under the search field,
 * the text of the status bar and the empty states. The answer to the last
 * page request ({@link PageOutcome}) decides them, with the page cache.
 */

import type { LibrarySearchHint } from "@/bindings";
import { type BookCountStatus, bookCountStatus } from "@/lib/book-count";
import type { BookSnapshot, PagedBookCache } from "@/lib/book-page-cache";
import { InvalidSearchError } from "@/lib/services/library/types";

/** A message about the search text, shown under the search field. */
export interface SearchFeedback {
	tone: "error" | "hint";
	text: string;
}

/**
 * The answer to the last page request, with the cache key of the request.
 * A load error also keeps the hints and the failed pages of its key.
 * The callout shows it until the next answer, so that it does not blink
 * between keystrokes. The grid uses it only while its key is current.
 */
export type PageOutcome =
	| { key: string; kind: "ok"; hints: string[] }
	| { key: string; kind: "searchError"; message: string }
	| {
			key: string;
			kind: "loadError";
			message: string;
			/** The hints of the text, from the pages of the key that loaded. */
			hints: string[];
			/** The pages of the key that failed, and did not load after that. */
			failedPages: number[];
	  };

/** A page request: the cache key of its filter and the index of the page. */
export interface PageRequest {
	key: string;
	pageIndex: number;
}

/** The failed pages of `outcome` other than `pageIndex`. */
const otherFailedPages = (
	outcome: PageOutcome | null,
	pageIndex: number,
): number[] =>
	outcome?.kind === "loadError"
		? outcome.failedPages.filter((page) => page !== pageIndex)
		: [];

/** The hint messages of `outcome`. */
const hintsOf = (outcome: PageOutcome | null): string[] =>
	outcome?.kind === "ok" || outcome?.kind === "loadError" ? outcome.hints : [];

/**
 * The outcome after a page of `request` loaded, with the messages of its
 * hints. A load error of another page of the same key stays until that page
 * loads, so that the status bar keeps it.
 */
export const loadedOutcome = (
	previous: PageOutcome | null,
	{ key, pageIndex }: PageRequest,
	hints: readonly LibrarySearchHint[],
): PageOutcome => {
	const messages = hints.map((hint) => hint.message);
	const own = outcomeFor(previous, key);
	const failedPages = otherFailedPages(own, pageIndex);
	if (own?.kind === "loadError" && failedPages.length > 0) {
		return { ...own, hints: messages, failedPages };
	}
	return { key, kind: "ok", hints: messages };
};

/**
 * The outcome after a page request failed. A load error keeps the hints of
 * the text and the other failed pages of the same key.
 */
export const failedOutcome = (
	previous: PageOutcome | null,
	{ key, pageIndex }: PageRequest,
	error: unknown,
): PageOutcome => {
	if (error instanceof InvalidSearchError) {
		return { key, kind: "searchError", message: error.message };
	}
	const own = outcomeFor(previous, key);
	const message =
		error instanceof Error ? error.message : "Failed to load books";
	return {
		key,
		kind: "loadError",
		message,
		hints: hintsOf(own),
		failedPages: [...otherFailedPages(own, pageIndex), pageIndex],
	};
};

/**
 * The outcome when it answers the request for `key`, or null. Only such an
 * outcome decides the grid, the status bar and the fetch of more pages.
 */
export const outcomeFor = (
	outcome: PageOutcome | null,
	key: string,
): PageOutcome | null => (outcome?.key === key ? outcome : null);

/**
 * The callout under the search field: all hints of the last page, or the
 * search error. A load error is not about the search text, so the status bar
 * shows it, and the callout keeps the hints.
 */
const searchFeedback = (outcome: PageOutcome | null): SearchFeedback | null => {
	if (outcome?.kind === "searchError")
		return { tone: "error", text: outcome.message };
	const hints = hintsOf(outcome);
	if (hints.length > 0) return { tone: "hint", text: hints.join(" ") };
	return null;
};

/**
 * What the grid shows:
 * - `loading`: no result yet, and one is due.
 * - `searching`: the last results, dimmed, while the result of a new filter
 *   is due.
 * - `stale`: the last results, not dimmed, because the new filter failed,
 *   or because the callout still shows the search error of an earlier
 *   filter.
 * - `failed`: nothing, because the filter failed and no earlier result
 *   exists.
 * - `ready`: the result of the current filter.
 */
export type GridStatus = "loading" | "searching" | "stale" | "failed" | "ready";

/** The facts that decide the status of the grid. */
interface GridSearchState {
	libraryReady: boolean;
	/** The total of the current filter is known. */
	queryResolved: boolean;
	hasStaleSnapshot: boolean;
	/** The last answer for the current filter is an error. */
	failed: boolean;
	/** The callout shows a search error, of this filter or of an earlier one. */
	showsSearchError: boolean;
}

const gridStatus = (state: GridSearchState): GridStatus => {
	if (!state.libraryReady) return "loading";
	if (state.queryResolved) return "ready";
	if (state.failed) return state.hasStaleSnapshot ? "stale" : "failed";
	if (!state.hasStaleSnapshot) return "loading";
	return state.showsSearchError ? "stale" : "searching";
};

/** The facts that decide whether the page shows the empty library state. */
interface EmptyLibraryState {
	status: GridStatus;
	libraryTotal: number | null;
	/** Books in the grid: of the current filter, or of the last results. */
	total: number;
}

/**
 * True when the page shows the empty library state. When the filter failed,
 * the library total can be unknown, so only a total of 0 gives true. In the
 * other statuses, the books in the grid replace a library total that did
 * not load.
 */
const isEmptyLibrary = (state: EmptyLibraryState): boolean =>
	state.status === "failed"
		? state.libraryTotal === 0
		: state.status !== "loading" && (state.libraryTotal ?? state.total) === 0;

/**
 * The text of the status bar. A load error of the current filter replaces the
 * count. A failed filter with no earlier results has no count, because the
 * callout gives the reason.
 */
const statusBarText = (
	status: GridStatus,
	current: PageOutcome | null,
	counts: Omit<BookCountStatus, "loading">,
): string => {
	if (current?.kind === "loadError")
		return `Could not load books: ${current.message}`;
	if (status === "failed") return "";
	return bookCountStatus({ ...counts, loading: status === "loading" });
};

/** The facts that decide what the book grid shows. */
export interface BookGridFacts {
	libraryReady: boolean;
	/** The cache of the current filter. Its total is null until a page answers. */
	cache: Pick<PagedBookCache, "key" | "total">;
	/** The last resolved results, which the grid shows while the filter loads. */
	staleSnapshot: Pick<BookSnapshot, "total"> | null;
	/** The answer to the last page request, for the current key or an older one. */
	pageOutcome: PageOutcome | null;
	/** Books in the whole library, or null when the count is not known. */
	libraryTotal: number | null;
	selectedCount: number;
}

/** What the book grid, the callout and the status bar show. */
export interface BookGridView {
	status: GridStatus;
	/** Books in the grid: of the current filter, or of the last results. */
	total: number;
	/**
	 * The callout under the search field. It shows the last answer also after
	 * a change of the filter, until the next answer.
	 */
	callout: SearchFeedback | null;
	/** The text of the status bar under the grid. */
	footer: string;
	/** True when the page shows the empty library state. */
	emptyLibrary: boolean;
	/**
	 * True when the current filter has a result with no books, in a library
	 * that has books.
	 */
	noMatches: boolean;
}

/**
 * What the book grid, the callout and the status bar show for these facts.
 * A search error goes to the callout, and a load error to the status bar. An
 * error changes the grid only when it answers the current filter.
 */
export const bookGridView = ({
	libraryReady,
	cache,
	staleSnapshot,
	pageOutcome,
	libraryTotal,
	selectedCount,
}: BookGridFacts): BookGridView => {
	const current = outcomeFor(pageOutcome, cache.key);
	const status = gridStatus({
		libraryReady,
		queryResolved: cache.total !== null,
		hasStaleSnapshot: staleSnapshot !== null,
		failed: current !== null && current.kind !== "ok",
		showsSearchError: pageOutcome?.kind === "searchError",
	});
	const total = cache.total ?? staleSnapshot?.total ?? 0;
	return {
		status,
		total,
		callout: searchFeedback(pageOutcome),
		footer: statusBarText(status, current, {
			total,
			libraryTotal,
			selectedCount,
		}),
		emptyLibrary: isEmptyLibrary({ status, libraryTotal, total }),
		noMatches: status === "ready" && total === 0 && (libraryTotal ?? 0) > 0,
	};
};
