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
	filter: { query: "sci-fi", sortOrder: "nameZa", hideRead: true },
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

	it("clearMissingActiveShelf detaches a shelf id that no longer exists but keeps filters", async () => {
		const storage = createFakeLocalStorage();
		const { useLibraryView } = await importStore(storage);

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().clearMissingActiveShelf(["some-other-shelf"]);

		const state = useLibraryView.getState();
		expect(state.activeShelfId).toBe(null);
		expect(state.query).toBe("sci-fi");
		expect(state.hideRead).toBe(true);

		const persisted = JSON.parse(storage.getItem(PREFS_KEY) ?? "{}");
		expect(persisted.activeShelfId).toBe(null);
	});

	it("clearMissingActiveShelf keeps an activeShelfId that still exists", async () => {
		const { useLibraryView } = await importStore(createFakeLocalStorage());

		useLibraryView.getState().applyShelf(shelf);
		useLibraryView.getState().clearMissingActiveShelf([shelf.id, "another"]);

		expect(useLibraryView.getState().activeShelfId).toBe(shelf.id);
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
