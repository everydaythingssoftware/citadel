import type { SmartShelf } from "@/lib/platform/settings/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const PREFS_KEY = "book-form-prefs";

const createFakeLocalStorage = () => {
	const backing = new Map<string, string>();
	return {
		getItem: (key: string) => backing.get(key) ?? null,
		setItem: (key: string, value: string) => {
			backing.set(key, value);
		},
		removeItem: (key: string) => {
			backing.delete(key);
		},
		clear: () => {
			backing.clear();
		},
	};
};

type FakeLocalStorage = ReturnType<typeof createFakeLocalStorage>;

// The store reads window.localStorage at import time, so each test stubs a
// fake window and re-imports a fresh module instance.
const importStore = async (storage: FakeLocalStorage) => {
	vi.resetModules();
	vi.stubGlobal("window", { localStorage: storage });
	return await import("./store");
};

const shelf: SmartShelf = {
	id: "shelf-1",
	name: "Unread Sci-Fi",
	filter: {
		query: "sci-fi",
		sortOrder: "nameZa",
		hideRead: true,
		searchScope: "titlesAuthorsSeries",
	},
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useLibraryView", () => {
	it("uses defaults when storage is empty", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		const state = useLibraryView.getState();
		expect(state.query).toBe("");
		expect(state.sortOrder).toBe("authorAz");
		expect(state.hideRead).toBe(false);
		expect(state.activeShelfId).toBe(null);
	});

	it("detachShelf drops the active shelf but keeps the filters", async () => {
		const storage = createFakeLocalStorage();
		const { useLibraryView } = await importStore(storage);
		useLibraryView.getState().applyShelf(shelf);

		useLibraryView.getState().detachShelf();

		const state = useLibraryView.getState();
		expect(state.activeShelfId).toBe(null);
		expect(state.query).toBe("sci-fi");
		expect(state.sortOrder).toBe("nameZa");
		expect(JSON.parse(storage.getItem(PREFS_KEY) ?? "{}").activeShelfId).toBe(
			null,
		);
	});

	it("applyShelf sets the filter fields and activeShelfId, and persists", async () => {
		const storage = createFakeLocalStorage();
		const { useLibraryView } = await importStore(storage);

		useLibraryView.getState().applyShelf(shelf);

		const state = useLibraryView.getState();
		expect(state.query).toBe("sci-fi");
		expect(state.sortOrder).toBe("nameZa");
		expect(state.hideRead).toBe(true);
		expect(state.activeShelfId).toBe("shelf-1");

		const persisted = JSON.parse(storage.getItem(PREFS_KEY) ?? "{}");
		expect(persisted).toMatchObject({
			query: "sci-fi",
			sortOrder: "nameZa",
			hideRead: true,
			activeShelfId: "shelf-1",
		});
	});

	it("setQuery clears the active shelf", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().setQuery("dune");

		expect(useLibraryView.getState().query).toBe("dune");
		expect(useLibraryView.getState().activeShelfId).toBe(null);
	});

	it("setSortOrder clears the active shelf", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().setSortOrder("authorZa");

		expect(useLibraryView.getState().sortOrder).toBe("authorZa");
		expect(useLibraryView.getState().activeShelfId).toBe(null);
	});

	it("setHideRead clears the active shelf", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().setHideRead(false);

		expect(useLibraryView.getState().hideRead).toBe(false);
		expect(useLibraryView.getState().activeShelfId).toBe(null);
	});

	it("the search scope persists and loads", async () => {
		const storage = createFakeLocalStorage();
		const first = await importStore(storage);

		first.useLibraryView.getState().setSearchScope("allFields");

		expect(JSON.parse(storage.getItem(PREFS_KEY) ?? "{}").searchScope).toBe(
			"allFields",
		);
		const second = await importStore(storage);
		expect(second.useLibraryView.getState().searchScope).toBe("allFields");
	});

	it("a stored scope that is not known loads as the default", async () => {
		const storage = createFakeLocalStorage();
		storage.setItem(PREFS_KEY, JSON.stringify({ searchScope: "yes" }));

		const { useLibraryView } = await importStore(storage);

		expect(useLibraryView.getState().searchScope).toBe("titlesAuthorsSeries");
	});

	it("changing the scope detaches the active shelf", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().setSearchScope("allFields");

		expect(useLibraryView.getState().searchScope).toBe("allFields");
		expect(useLibraryView.getState().activeShelfId).toBe(null);
	});

	it("selecting the current scope keeps the active shelf", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		const { searchScope } = useLibraryView.getState();
		useLibraryView.getState().setSearchScope(searchScope);

		expect(useLibraryView.getState().activeShelfId).toBe("shelf-1");
	});

	it("a shelf applies its scope", async () => {
		const storage = createFakeLocalStorage();
		const { useLibraryView } = await importStore(storage);
		const stored = () =>
			JSON.parse(storage.getItem(PREFS_KEY) ?? "{}").searchScope;

		useLibraryView.getState().applyShelf({
			...shelf,
			filter: { ...shelf.filter, searchScope: "allFields" },
		});
		expect(useLibraryView.getState().searchScope).toBe("allFields");
		expect(stored()).toBe("allFields");

		useLibraryView.getState().applyShelf(shelf);
		expect(useLibraryView.getState().searchScope).toBe("titlesAuthorsSeries");
		expect(stored()).toBe("titlesAuthorsSeries");
	});

	it("a shelf with stored values that are not valid applies the defaults", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf({
			...shelf,
			filter: {
				...shelf.filter,
				searchScope: "true" as never,
				hideRead: "yes" as never,
			},
		});

		const state = useLibraryView.getState();
		expect(state.searchScope).toBe("titlesAuthorsSeries");
		expect(state.hideRead).toBe(false);
	});

	it("a shelf with a query or a sort that is not valid applies the defaults and warns", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		useLibraryView.getState().applyShelf({
			...shelf,
			filter: {
				...shelf.filter,
				query: 5 as never,
				sortOrder: "titleAz" as never,
			},
		});

		const state = useLibraryView.getState();
		expect(state.query).toBe("");
		expect(state.sortOrder).toBe("authorAz");
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain(shelf.id);
		expect(String(warn.mock.calls[0]?.[0])).toContain("query, sortOrder");
		warn.mockRestore();
	});

	it("showing all books keeps the scope", async () => {
		const storage = createFakeLocalStorage();
		const { useLibraryView } = await importStore(storage);

		useLibraryView.getState().setSearchScope("allFields");
		useLibraryView.getState().resetToAllBooks();

		expect(useLibraryView.getState().searchScope).toBe("allFields");
		expect(JSON.parse(storage.getItem(PREFS_KEY) ?? "{}").searchScope).toBe(
			"allFields",
		);
	});

	it("resetToAllBooks clears query, hideRead, and activeShelfId but keeps sort", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().resetToAllBooks();

		const state = useLibraryView.getState();
		expect(state.query).toBe("");
		expect(state.hideRead).toBe(false);
		expect(state.activeShelfId).toBe(null);
		expect(state.sortOrder).toBe("nameZa");
	});

	it("syncActiveShelf detaches a shelf id that no longer exists but keeps filters", async () => {
		const storage = createFakeLocalStorage();
		const { useLibraryView } = await importStore(storage);

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView
			.getState()
			.syncActiveShelf([{ ...shelf, id: "some-other-shelf" }]);

		const state = useLibraryView.getState();
		expect(state.activeShelfId).toBe(null);
		expect(state.query).toBe("sci-fi");
		expect(state.hideRead).toBe(true);

		const persisted = JSON.parse(storage.getItem(PREFS_KEY) ?? "{}");
		expect(persisted.activeShelfId).toBe(null);
	});

	it("syncActiveShelf keeps an activeShelfId that still exists", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView
			.getState()
			.syncActiveShelf([shelf, { ...shelf, id: "another" }]);

		expect(useLibraryView.getState().activeShelfId).toBe(shelf.id);
	});

	it("syncActiveShelf applies the filter of the active shelf again when it changed", async () => {
		const storage = createFakeLocalStorage();
		storage.setItem(
			PREFS_KEY,
			JSON.stringify({ query: "not a penny more", activeShelfId: shelf.id }),
		);
		const { useLibraryView } = await importStore(storage);
		const migrated = {
			...shelf,
			filter: { ...shelf.filter, query: '"not a penny more"' },
		};

		useLibraryView.getState().syncActiveShelf([migrated]);

		const state = useLibraryView.getState();
		expect(state.query).toBe('"not a penny more"');
		expect(state.sortOrder).toBe("nameZa");
		expect(state.hideRead).toBe(true);
		expect(state.activeShelfId).toBe(shelf.id);
		expect(JSON.parse(storage.getItem(PREFS_KEY) ?? "{}").query).toBe(
			'"not a penny more"',
		);
	});

	it("restores persisted state, including activeShelfId, on restart", async () => {
		const storage = createFakeLocalStorage();
		const first = await importStore(storage);
		first.useLibraryView.getState().applyShelf(shelf);

		const second = await importStore(storage);
		const state = second.useLibraryView.getState();
		expect(state.query).toBe("sci-fi");
		expect(state.sortOrder).toBe("nameZa");
		expect(state.hideRead).toBe(true);
		expect(state.activeShelfId).toBe("shelf-1");
	});
});
