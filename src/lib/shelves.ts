import { SORT_LABELS } from "@/lib/library-sort-options";
import type {
	ShelfViewFields,
	SmartShelfFilter,
} from "@/lib/platform/settings/types";
import { SEARCH_SCOPE_LABELS } from "@/lib/search-scope";

/** The Books route's deep-link filters (its search params). */
export interface BookRouteFilters {
	author_id?: string;
	series_id?: number;
	tag_id?: number;
	publisher_id?: number;
}

export const hasRouteFilters = (route: BookRouteFilters): boolean =>
	route.author_id !== undefined ||
	route.series_id !== undefined ||
	route.tag_id !== undefined ||
	route.publisher_id !== undefined;

/** The deep-link part of a shelf, as route search params for opening it. */
export const shelfRouteFilters = (
	filter: SmartShelfFilter,
): BookRouteFilters => ({
	...(filter.authorId !== undefined && { author_id: filter.authorId }),
	...(filter.seriesId !== undefined && { series_id: filter.seriesId }),
	...(filter.tagId !== undefined && { tag_id: filter.tagId }),
	...(filter.publisherId !== undefined && { publisher_id: filter.publisherId }),
});

/**
 * The deep-link filters of the current view, as shelf filter fields. Ids are
 * library-local, so a shelf with any of them is scoped to `libraryId`.
 */
export const routeFiltersToShelf = (
	route: BookRouteFilters,
	libraryId: string | undefined,
): Pick<
	SmartShelfFilter,
	"authorId" | "seriesId" | "tagId" | "publisherId" | "libraryId"
> => ({
	...(route.author_id !== undefined && { authorId: route.author_id }),
	...(route.series_id !== undefined && { seriesId: route.series_id }),
	...(route.tag_id !== undefined && { tagId: route.tag_id }),
	...(route.publisher_id !== undefined && { publisherId: route.publisher_id }),
	...(hasRouteFilters(route) && libraryId !== undefined && { libraryId }),
});

/**
 * The filter of a new shelf for the current view, its scope included, with
 * the route filters of the view. "Save as shelf…" stores it.
 */
export const shelfFilterFromView = (
	view: ShelfViewFields,
	routeFilters: BookRouteFilters,
	libraryId: string | undefined,
): SmartShelfFilter => ({
	query: view.query,
	sortOrder: view.sortOrder,
	hideRead: view.hideRead,
	searchScope: view.searchScope,
	...routeFiltersToShelf(routeFilters, libraryId),
});

/**
 * The text that tells what "Save as shelf…" stores for the current view. It
 * names each field that {@link shelfFilterFromView} stores, the scope too.
 */
export const shelfViewSummary = (
	view: ShelfViewFields,
	routeFilters: BookRouteFilters,
): string => {
	const query = view.query.trim();
	return [
		...(hasRouteFilters(routeFilters) ? ["this view's filter"] : []),
		query.length > 0 ? `search "${query}"` : "no search",
		`search scope "${SEARCH_SCOPE_LABELS[view.searchScope]}"`,
		`sorted by ${SORT_LABELS[view.sortOrder]}`,
		view.hideRead ? "hiding read books" : "showing read books",
	].join(", ");
};

/** Whether a shelf belongs in this library; shelves without ids are global. */
export const shelfInLibrary = (
	filter: SmartShelfFilter,
	libraryId: string | undefined,
): boolean => filter.libraryId === undefined || filter.libraryId === libraryId;

/** Whether the current route shows exactly the shelf's deep-link filters. */
export const shelfMatchesRoute = (
	filter: SmartShelfFilter,
	route: BookRouteFilters,
): boolean =>
	filter.authorId === route.author_id &&
	filter.seriesId === route.series_id &&
	filter.tagId === route.tag_id &&
	filter.publisherId === route.publisher_id;

/** Read the route's filters out of an untyped search object. */
export const routeFiltersFromSearch = (search: unknown): BookRouteFilters => {
	const raw = (search ?? {}) as Record<string, unknown>;
	return {
		...(typeof raw.author_id === "string" && { author_id: raw.author_id }),
		...(typeof raw.series_id === "number" && { series_id: raw.series_id }),
		...(typeof raw.tag_id === "number" && { tag_id: raw.tag_id }),
		...(typeof raw.publisher_id === "number" && {
			publisher_id: raw.publisher_id,
		}),
	};
};

/**
 * Whether landing on a route with deep-link filters should clear the text
 * query ("those books in one click"). Not when arriving through the shelf
 * that was saved from that very view: its query belongs to the shelf.
 */
export const deepLinkClearsQuery = (
	route: BookRouteFilters,
	activeShelf: SmartShelfFilter | undefined,
): boolean =>
	hasRouteFilters(route) &&
	!(activeShelf !== undefined && shelfMatchesRoute(activeShelf, route));

/** Whether the active shelf stopped matching the route it was opened on. */
export const shelfLeftRoute = (
	route: BookRouteFilters,
	activeShelf: SmartShelfFilter | undefined,
): boolean =>
	activeShelf !== undefined && !shelfMatchesRoute(activeShelf, route);
