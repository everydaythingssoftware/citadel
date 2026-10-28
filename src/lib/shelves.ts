import type { SmartShelfFilter } from "@/lib/platform/settings/types";

export interface ShelfTarget {
	title: string;
	path: string;
}

// Order defines the mod+1..mod+9 shelf chords; "All books" must stay first.
// Keep in sync with the destinations rendered in Sidebar.
export const SHELF_TARGETS = [
	{ title: "All Books", path: "/" },
	{ title: "Authors", path: "/authors" },
] as const satisfies readonly ShelfTarget[];

export const MAX_SHELF_CHORDS = 9;

export const chordForShelf = (index: number): string | null =>
	index >= 0 && index < MAX_SHELF_CHORDS ? `mod+${index + 1}` : null;

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

/** The deep-link filters of the current view, as shelf filter fields. */
export const routeFiltersToShelf = (
	route: BookRouteFilters,
): Pick<
	SmartShelfFilter,
	"authorId" | "seriesId" | "tagId" | "publisherId"
> => ({
	...(route.author_id !== undefined && { authorId: route.author_id }),
	...(route.series_id !== undefined && { seriesId: route.series_id }),
	...(route.tag_id !== undefined && { tagId: route.tag_id }),
	...(route.publisher_id !== undefined && { publisherId: route.publisher_id }),
});

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
