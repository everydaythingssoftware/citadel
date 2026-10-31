import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import {
	advanceSnapshot,
	applyBookPage,
	BOOK_PAGE_SIZE,
	type BookGridFilter,
	cacheForKey,
	compareBySeriesIndex,
	emptyBookCache,
	invalidateBookCache,
	pagesCoveringRange,
	pagesToFetch,
	serializeBookFilter,
	sparseBookItems,
	toBookQuery,
} from "./book-page-cache";

const book = (id: string, extra: Partial<LibraryBook> = {}): LibraryBook => ({
	id,
	uuid: null,
	title: `Book ${id}`,
	author_list: [],
	tag_list: [],
	sortable_title: null,
	file_list: [],
	cover_image: null,
	identifier_list: [],
	description: null,
	is_read: false,
	series: null,
	series_index: null,
	language_list: [],
	...extra,
});

const filter = (overrides: Partial<BookGridFilter> = {}): BookGridFilter => ({
	text: "",
	authorId: null,
	seriesId: null,
	tagId: null,
	publisherId: null,
	hideRead: false,
	sortOrder: "authorAz",
	...overrides,
});

describe("serializeBookFilter", () => {
	it("treats empty and whitespace-only text as the same key", () => {
		expect(serializeBookFilter(filter({ text: "" }))).toBe(
			serializeBookFilter(filter({ text: "   " })),
		);
	});

	it("trims text so padding does not fork the cache", () => {
		expect(serializeBookFilter(filter({ text: " dune " }))).toBe(
			serializeBookFilter(filter({ text: "dune" })),
		);
	});

	it("changes when any filter dimension changes", () => {
		const base = serializeBookFilter(filter());
		expect(serializeBookFilter(filter({ text: "dune" }))).not.toBe(base);
		expect(serializeBookFilter(filter({ authorId: "7" }))).not.toBe(base);
		expect(serializeBookFilter(filter({ seriesId: 3 }))).not.toBe(base);
		expect(serializeBookFilter(filter({ tagId: 4 }))).not.toBe(base);
		expect(serializeBookFilter(filter({ publisherId: 5 }))).not.toBe(base);
		expect(serializeBookFilter(filter({ hideRead: true }))).not.toBe(base);
		expect(serializeBookFilter(filter({ sortOrder: "nameZa" }))).not.toBe(base);
	});
});

describe("toBookQuery", () => {
	it("maps page index to limit/offset and sort keys to backend orders", () => {
		const query = toBookQuery(filter({ sortOrder: "nameZa" }), 3, 50);
		expect(query).toMatchObject({
			text: null,
			sort: "TitleDesc",
			limit: 50,
			offset: 150,
		});
	});

	it("maps every sort order", () => {
		expect(toBookQuery(filter({ sortOrder: "nameAz" }), 0).sort).toBe(
			"TitleAsc",
		);
		expect(toBookQuery(filter({ sortOrder: "nameZa" }), 0).sort).toBe(
			"TitleDesc",
		);
		expect(toBookQuery(filter({ sortOrder: "authorAz" }), 0).sort).toBe(
			"AuthorAsc",
		);
		expect(toBookQuery(filter({ sortOrder: "authorZa" }), 0).sort).toBe(
			"AuthorDesc",
		);
	});

	it("nullifies blank text and passes trimmed text through", () => {
		expect(toBookQuery(filter({ text: "  " }), 0).text).toBeNull();
		expect(toBookQuery(filter({ text: " dune " }), 0).text).toBe("dune");
	});

	it("passes tag and publisher filters through, paged as usual", () => {
		const query = toBookQuery(filter({ tagId: 4, publisherId: 5 }), 2, 50);
		expect(query.tag_id).toBe(4);
		expect(query.publisher_id).toBe(5);
		expect(query.limit).toBe(50);
		expect(query.offset).toBe(100);
	});

	it("fetches a whole series as one unbounded page", () => {
		const query = toBookQuery(filter({ seriesId: 9 }), 2, 50);
		expect(query.series_id).toBe(9);
		expect(query.limit).toBeNull();
		expect(query.offset).toBe(0);
	});
});

describe("pagesCoveringRange", () => {
	it("maps an index range to the pages containing it", () => {
		expect(pagesCoveringRange(0, 99, 100)).toEqual([0]);
		expect(pagesCoveringRange(99, 100, 100)).toEqual([0, 1]);
		expect(pagesCoveringRange(250, 460, 100)).toEqual([2, 3, 4]);
	});

	it("clamps to the known total", () => {
		expect(pagesCoveringRange(80, 500, 100, 120)).toEqual([0, 1]);
		expect(pagesCoveringRange(200, 300, 100, 120)).toEqual([]);
	});

	it("does not clamp the end while the total is unknown", () => {
		expect(pagesCoveringRange(0, 150, 100, null)).toEqual([0, 1]);
	});

	it("returns no pages for empty or negative ranges", () => {
		expect(pagesCoveringRange(10, 5, 100)).toEqual([]);
		expect(pagesCoveringRange(-20, -1, 100)).toEqual([]);
		expect(pagesCoveringRange(0, 10, 100, 0)).toEqual([]);
	});

	it("clamps negative starts to page zero", () => {
		expect(pagesCoveringRange(-5, 10, 100)).toEqual([0]);
	});
});

describe("cacheForKey", () => {
	it("keeps the cache when the key is unchanged", () => {
		const cache = emptyBookCache("a", 1);
		expect(cacheForKey(cache, "a")).toBe(cache);
	});

	it("starts an empty cache under the next generation for a new key", () => {
		const cache = applyBookPage(emptyBookCache("a", 1), {
			key: "a",
			generation: 1,
			pageIndex: 0,
			items: [book("1")],
			total: 1,
		});
		const next = cacheForKey(cache, "b");
		expect(next.key).toBe("b");
		expect(next.generation).toBe(2);
		expect(next.total).toBeNull();
		expect(next.pages.size).toBe(0);
	});
});

describe("applyBookPage / generation invalidation", () => {
	const loaded = () =>
		applyBookPage(emptyBookCache("a", 1), {
			key: "a",
			generation: 1,
			pageIndex: 0,
			items: [book("1"), book("2")],
			total: 5,
		});

	it("lands a page and learns the total", () => {
		const cache = loaded();
		expect(cache.total).toBe(5);
		expect(cache.pages.get(0)?.map((b) => b.id)).toEqual(["1", "2"]);
	});

	it("drops results from a superseded key", () => {
		const cache = loaded();
		const next = applyBookPage(cache, {
			key: "b",
			generation: 1,
			pageIndex: 1,
			items: [book("9")],
			total: 9,
		});
		expect(next).toBe(cache);
	});

	it("drops results from a superseded generation", () => {
		const invalidated = invalidateBookCache(loaded());
		const next = applyBookPage(invalidated, {
			key: "a",
			generation: 1, // started before the invalidation
			pageIndex: 0,
			items: [book("stale")],
			total: 5,
		});
		expect(next).toBe(invalidated);
		expect(next.stale.has(0)).toBe(true);
	});

	it("invalidation keeps pages on screen as stale, with the key and total", () => {
		const before = loaded();
		const cache = invalidateBookCache(before);
		expect(cache.key).toBe("a");
		expect(cache.generation).toBe(2);
		expect(cache.total).toBe(5);
		expect(cache.pages).toBe(before.pages);
		expect([...cache.stale]).toEqual([...before.pages.keys()]);
		expect(pagesToFetch(cache, [0, 1])).toEqual([0, 1]);
		expect(pagesToFetch(before, [0, 1])).toEqual([1]);
	});

	it("accepts pages fetched under the post-invalidation generation", () => {
		const cache = invalidateBookCache(loaded());
		const next = applyBookPage(cache, {
			key: "a",
			generation: 2,
			pageIndex: 0,
			items: [book("fresh")],
			total: 4,
		});
		expect(next.total).toBe(4);
		expect(next.pages.get(0)?.[0]?.id).toBe("fresh");
		expect(next.stale.has(0)).toBe(false);
	});
});

describe("sparseBookItems", () => {
	it("places pages at their flat offsets and leaves holes undefined", () => {
		let cache = emptyBookCache("a", 1);
		cache = applyBookPage(cache, {
			key: "a",
			generation: 1,
			pageIndex: 1,
			items: [book("3"), book("4")],
			total: 5,
		});
		const items = sparseBookItems(cache, 2);
		expect(items).toHaveLength(5);
		expect(items[0]).toBeUndefined();
		expect(items[1]).toBeUndefined();
		expect(items[2]?.id).toBe("3");
		expect(items[3]?.id).toBe("4");
		expect(items[4]).toBeUndefined();
	});

	it("is empty while the total is unknown", () => {
		expect(sparseBookItems(emptyBookCache("a", 1))).toEqual([]);
	});

	it("ignores items beyond the total (shrunk filter results)", () => {
		let cache = emptyBookCache("a", 1);
		cache = applyBookPage(cache, {
			key: "a",
			generation: 1,
			pageIndex: 0,
			items: [book("1"), book("2"), book("3")],
			total: 2,
		});
		expect(sparseBookItems(cache, BOOK_PAGE_SIZE)).toHaveLength(2);
	});

	it("supports an oversized series page at page zero", () => {
		let cache = emptyBookCache("a", 1);
		cache = applyBookPage(cache, {
			key: "a",
			generation: 1,
			pageIndex: 0,
			items: [book("1"), book("2"), book("3")],
			total: 3,
		});
		// Page size 2, but the series special case lands everything in page 0.
		const items = sparseBookItems(cache, 2);
		expect(items.map((item) => item?.id)).toEqual(["1", "2", "3"]);
	});
});

describe("advanceSnapshot (stale-while-revalidate)", () => {
	const loadedCache = () => {
		const c = emptyBookCache("a", 1);
		return applyBookPage(c, {
			key: "a",
			generation: 1,
			pageIndex: 0,
			items: [book("1"), book("2")],
			total: 2,
		});
	};

	it("returns null for an unresolved cache with no prior snapshot", () => {
		expect(advanceSnapshot(emptyBookCache("a", 1), null)).toBeNull();
	});

	it("preserves an existing snapshot while a new key has no total yet", () => {
		const snapshot = {
			key: "a",
			items: [book("1")],
			total: 1,
		};
		const transitioning = emptyBookCache("b", 2); // new key, not yet resolved
		const result = advanceSnapshot(transitioning, snapshot);
		expect(result).toBe(snapshot); // unchanged
	});

	it("creates a snapshot once the cache resolves", () => {
		const cache = loadedCache();
		const snapshot = advanceSnapshot(cache, null);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.key).toBe("a");
		expect(snapshot?.total).toBe(2);
		expect(snapshot?.items).toHaveLength(2);
	});

	it("refreshes the snapshot when the same key gets new pages", () => {
		const first = advanceSnapshot(loadedCache(), null);
		// Second page arrives for the same key
		let cache = loadedCache();
		cache = applyBookPage(cache, {
			key: "a",
			generation: 1,
			pageIndex: 1,
			items: [book("3")],
			total: 3,
		});
		const second = advanceSnapshot(cache, first);
		expect(second?.total).toBe(3);
		expect(second?.items).toHaveLength(3);
		expect(second?.key).toBe("a");
	});

	it("replaces an old-key snapshot when a new key resolves", () => {
		const oldSnapshot = advanceSnapshot(loadedCache(), null);
		// New key resolves immediately (e.g. first page arrives)
		const newCache = applyBookPage(emptyBookCache("b", 2), {
			key: "b",
			generation: 2,
			pageIndex: 0,
			items: [book("x")],
			total: 1,
		});
		const result = advanceSnapshot(newCache, oldSnapshot);
		expect(result?.key).toBe("b");
		expect(result?.total).toBe(1);
	});

	it("a key transition does not blank: snapshot from key A is held while key B is in flight", () => {
		// Simulate: key A has data -> key changes to B (unresolved) -> snapshot stays at A
		const cacheA = loadedCache();
		const snapshotA = advanceSnapshot(cacheA, null);
		expect(snapshotA).not.toBeNull();

		// cacheForKey produces an empty cache for key B
		const cacheB = cacheForKey(cacheA, "b");
		expect(cacheB.total).toBeNull();

		// advanceSnapshot keeps the A snapshot while B is unresolved
		const snapshotDuring = advanceSnapshot(cacheB, snapshotA);
		expect(snapshotDuring).toBe(snapshotA);
		expect(snapshotDuring?.key).toBe("a");
	});
});

describe("compareBySeriesIndex", () => {
	it("orders by series index, pushing index-less books last", () => {
		const books = [
			book("c", { series_index: null }),
			book("b", { series_index: 2 }),
			book("a", { series_index: 1 }),
		];
		expect([...books].sort(compareBySeriesIndex).map((b) => b.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("breaks index ties by title", () => {
		const books = [
			book("z", { title: "Zeta", series_index: 1 }),
			book("a", { title: "Alpha", series_index: 1 }),
		];
		expect([...books].sort(compareBySeriesIndex).map((b) => b.id)).toEqual([
			"a",
			"z",
		]);
	});
});
