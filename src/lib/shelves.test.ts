import { describe, expect, it } from "vitest";
import type { SmartShelfFilter } from "@/lib/platform/settings/types";
import {
	MAX_SHELF_CHORDS,
	SHELF_TARGETS,
	chordForShelf,
	deepLinkClearsQuery,
	hasRouteFilters,
	routeFiltersFromSearch,
	routeFiltersToShelf,
	shelfLeftRoute,
	shelfMatchesRoute,
	shelfRouteFilters,
} from "./shelves";

describe("SHELF_TARGETS", () => {
	it("puts All Books first so it owns mod+1", () => {
		expect(SHELF_TARGETS[0]).toEqual({ title: "All Books", path: "/" });
	});

	it("fits every shelf within the chordable range", () => {
		expect(SHELF_TARGETS.length).toBeLessThanOrEqual(MAX_SHELF_CHORDS);
	});
});

describe("chordForShelf", () => {
	it("maps shelf order to one-based digit chords", () => {
		expect(chordForShelf(0)).toBe("mod+1");
		expect(chordForShelf(1)).toBe("mod+2");
		expect(chordForShelf(MAX_SHELF_CHORDS - 1)).toBe("mod+9");
	});

	it("returns null outside the chordable range", () => {
		expect(chordForShelf(-1)).toBeNull();
		expect(chordForShelf(MAX_SHELF_CHORDS)).toBeNull();
	});
});

const baseFilter: SmartShelfFilter = {
	query: "",
	sortOrder: "authorAz",
	hideRead: false,
};

describe("shelf route filters", () => {
	it("round-trips a tag view through a shelf back to route params", () => {
		const saved = { ...baseFilter, ...routeFiltersToShelf({ tag_id: 7 }) };
		expect(saved.tagId).toBe(7);
		expect(shelfRouteFilters(saved)).toEqual({ tag_id: 7 });
	});

	it("round-trips author, series and publisher views too", () => {
		const route = { author_id: "a1", series_id: 2, publisher_id: 3 };
		const saved = { ...baseFilter, ...routeFiltersToShelf(route) };
		expect(shelfRouteFilters(saved)).toEqual(route);
	});

	it("leaves shelves saved before these fields existed unfiltered", () => {
		expect(shelfRouteFilters(baseFilter)).toEqual({});
		expect(shelfMatchesRoute(baseFilter, {})).toBe(true);
	});

	it("does not write undefined keys into the saved shelf", () => {
		expect(Object.keys(routeFiltersToShelf({}))).toEqual([]);
	});

	it("matches only the exact filters of the shelf", () => {
		const shelf = { ...baseFilter, tagId: 7 };
		expect(shelfMatchesRoute(shelf, { tag_id: 7 })).toBe(true);
		expect(shelfMatchesRoute(shelf, {})).toBe(false);
		expect(shelfMatchesRoute(shelf, { tag_id: 8 })).toBe(false);
		expect(shelfMatchesRoute(shelf, { tag_id: 7, author_id: "a" })).toBe(false);
		expect(shelfMatchesRoute(baseFilter, { tag_id: 7 })).toBe(false);
	});

	it("detects any deep-link filter", () => {
		expect(hasRouteFilters({})).toBe(false);
		expect(hasRouteFilters({ publisher_id: 1 })).toBe(true);
	});

	it("reads typed route filters out of an untyped search object", () => {
		expect(
			routeFiltersFromSearch({ tag_id: 3, author_id: "x", series_id: "9" }),
		).toEqual({ tag_id: 3, author_id: "x" });
		expect(routeFiltersFromSearch(undefined)).toEqual({});
	});
});

describe("deepLinkClearsQuery", () => {
	const tagShelf = { ...baseFilter, query: "dune", tagId: 7 };

	it("clears the query on a plain deep link", () => {
		expect(deepLinkClearsQuery({ tag_id: 7 }, undefined)).toBe(true);
		expect(deepLinkClearsQuery({ tag_id: 7 }, baseFilter)).toBe(true);
	});

	it("keeps the shelf's own query when arriving through that shelf", () => {
		expect(deepLinkClearsQuery({ tag_id: 7 }, tagShelf)).toBe(false);
	});

	it("clears it when a different link is followed while a shelf is active", () => {
		expect(deepLinkClearsQuery({ tag_id: 8 }, tagShelf)).toBe(true);
	});

	it("never clears on a route without deep-link filters", () => {
		expect(deepLinkClearsQuery({}, undefined)).toBe(false);
		expect(deepLinkClearsQuery({}, tagShelf)).toBe(false);
	});
});

describe("shelfLeftRoute", () => {
	const tagShelf = { ...baseFilter, tagId: 7 };

	it("flags a shelf whose filter token was removed or never restored", () => {
		expect(shelfLeftRoute({}, tagShelf)).toBe(true);
		expect(shelfLeftRoute({ tag_id: 8 }, tagShelf)).toBe(true);
	});

	it("keeps a shelf while the route still shows its filter", () => {
		expect(shelfLeftRoute({ tag_id: 7 }, tagShelf)).toBe(false);
		expect(shelfLeftRoute({}, baseFilter)).toBe(false);
	});

	it("has nothing to flag without an active shelf", () => {
		expect(shelfLeftRoute({ tag_id: 7 }, undefined)).toBe(false);
	});
});
