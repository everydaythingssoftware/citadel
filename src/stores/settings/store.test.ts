import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryEntry } from "@/bindings";
import {
	defaultSettings,
	type SettingsKey,
	type SettingsManager,
	type SettingsSchema,
	type SettingsValue,
	type SmartShelfFilter,
} from "@/lib/platform/settings/types";

// An in-memory stand-in for the citadel.db registry behind LibraryCatalog.
// Paths under /missing are treated as folders that no longer hold a library.
const registry = vi.hoisted(() => ({
	libraries: [] as LibraryEntry[],
	removed: new Map<string, { entry: LibraryEntry; index: number }>(),
}));
const idFor = (path: string) => `calibre-${path}`;
vi.mock("@/lib/services/library-catalog", () => ({
	libraryCatalog: {
		list: async () => [...registry.libraries],
		register: async (path: string) => {
			const existing = registry.libraries.find(({ id }) => id === idFor(path));
			if (existing) return existing;
			const library = {
				id: idFor(path),
				displayName: path.split("/").at(-1) ?? "",
				absolutePath: path,
			};
			registry.libraries.push(library);
			return library;
		},
		remove: async (id: string) => {
			const index = registry.libraries.findIndex((entry) => entry.id === id);
			const [removed] = registry.libraries.splice(index, 1);
			if (removed) registry.removed.set(id, { entry: removed, index });
		},
		restore: async (id: string) => {
			const removed = registry.removed.get(id);
			if (!removed) throw new Error("This library can no longer be restored.");
			registry.removed.delete(id);
			registry.libraries.splice(removed.index, 0, removed.entry);
			return removed.entry;
		},
		rename: async (id: string, displayName: string) => {
			const library = registry.libraries.find((entry) => entry.id === id);
			if (!library) throw new Error(`No library has ID '${id}'.`);
			library.displayName = displayName;
			return { ...library };
		},
		importLegacy: async (entries: LibraryEntry[]) => {
			const kept = entries.filter(
				({ absolutePath }) => !absolutePath.startsWith("/missing"),
			);
			for (const entry of kept)
				registry.libraries.push({ ...entry, id: idFor(entry.absolutePath) });
			return {
				libraries: [...registry.libraries],
				idChanges: kept.map((entry) => ({
					previousId: entry.id,
					id: idFor(entry.absolutePath),
				})),
				dropped: entries.filter(({ absolutePath }) =>
					absolutePath.startsWith("/missing"),
				),
			};
		},
		onChange: async () => () => {},
	},
}));

beforeEach(() => {
	registry.libraries = [];
	registry.removed.clear();
});

const setSetting = <K extends SettingsKey>(
	target: SettingsSchema,
	key: K,
	value: SettingsValue<K>,
) => {
	target[key] = value;
};

// Mirrors createWebSettingsManager (web.ts), but backed by a Map so the
// fake "disk" outlives store re-imports — letting tests simulate an app
// restart by re-initializing a fresh store with the same manager.
const createFakeSettingsManager = (): SettingsManager => {
	const backing = new Map<string, string>();
	return {
		initialize: () => {
			// Seed default values for missing keys
			for (const [key, value] of Object.entries(defaultSettings)) {
				if (!backing.has(key)) {
					backing.set(key, JSON.stringify(value));
				}
			}

			// Return fresh values from the backing map
			const initialSettings = {} as SettingsSchema;
			for (const key of Object.keys(defaultSettings) as SettingsKey[]) {
				const item = backing.get(key);

				const parsed = item
					? (JSON.parse(item) as SettingsValue<typeof key>)
					: defaultSettings[key];

				setSetting(initialSettings, key, parsed);
			}

			return Promise.resolve(initialSettings);
		},

		set: <K extends SettingsKey>(key: K, value: SettingsValue<K>) => {
			backing.set(key, JSON.stringify(value));

			return Promise.resolve();
		},

		get: <K extends SettingsKey>(key: K) => {
			const item = backing.get(key);

			if (!item) {
				throw new Error(`Settings store missing key ${key}`);
			}

			const parsed = JSON.parse(item) as SettingsValue<K>;

			return Promise.resolve(parsed);
		},
	};
};

// Each test re-imports a fresh module instance so zustand state from one
// test (or one simulated "app run") cannot leak into the next.
const importStore = async (manager: SettingsManager) => {
	vi.resetModules();
	const { useSettings } = await import("./store");
	await useSettings.getState().init(manager);
	return useSettings;
};

const filter: SmartShelfFilter = {
	query: "dune",
	sortOrder: "nameAz",
	hideRead: false,
};

describe("useSettings smart shelves", () => {
	it("init hydrates smartShelves with the built-in Unread shelf", async () => {
		const useSettings = await importStore(createFakeSettingsManager());

		const state = useSettings.getState();
		expect(state.hydrated).toBe(true);
		expect(state.smartShelves).toEqual([
			{
				id: "builtin-unread",
				name: "Unread",
				filter: { query: "", sortOrder: "authorAz", hideRead: true },
			},
		]);
	});

	it("createSmartShelf trims the name, returns the shelf, and persists it", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);

		const shelf = await useSettings
			.getState()
			.createSmartShelf("  Sci-Fi  ", filter);

		expect(shelf.name).toBe("Sci-Fi");
		expect(shelf.filter).toEqual(filter);
		expect(useSettings.getState().smartShelves).toHaveLength(2);
		expect(useSettings.getState().smartShelves).toContainEqual(shelf);

		const persisted = await manager.get("smartShelves");
		expect(persisted).toContainEqual(shelf);
	});

	it("keeps a created shelf across an app restart with the same manager", async () => {
		const manager = createFakeSettingsManager();
		const first = await importStore(manager);
		const shelf = await first.getState().createSmartShelf("Sci-Fi", filter);

		// Simulate restart: fresh store module, same persisted settings
		const second = await importStore(manager);

		expect(second.getState().smartShelves).toContainEqual(shelf);
		expect(second.getState().smartShelves).toHaveLength(2);
	});

	it("createSmartShelf rejects a case-insensitive duplicate name without changing state", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);

		await expect(
			useSettings.getState().createSmartShelf("unread", filter),
		).rejects.toThrow('A shelf named "unread" already exists');

		expect(useSettings.getState().smartShelves).toHaveLength(1);
		expect(await manager.get("smartShelves")).toHaveLength(1);
	});

	it("createSmartShelf rejects empty and whitespace-only names without changing state", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);

		await expect(
			useSettings.getState().createSmartShelf("", filter),
		).rejects.toThrow("Shelf name cannot be empty");
		await expect(
			useSettings.getState().createSmartShelf("   ", filter),
		).rejects.toThrow("Shelf name cannot be empty");

		expect(useSettings.getState().smartShelves).toHaveLength(1);
		expect(await manager.get("smartShelves")).toHaveLength(1);
	});

	it("renameSmartShelf renames the shelf and persists it", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);
		const shelf = await useSettings
			.getState()
			.createSmartShelf("Sci-Fi", filter);

		await useSettings.getState().renameSmartShelf(shelf.id, "  Space Opera  ");

		const renamed = useSettings
			.getState()
			.smartShelves.find((s) => s.id === shelf.id);
		expect(renamed?.name).toBe("Space Opera");

		const persisted = await manager.get("smartShelves");
		expect(persisted).toContainEqual({ ...shelf, name: "Space Opera" });
	});

	it("renameSmartShelf rejects a name held by another shelf", async () => {
		const useSettings = await importStore(createFakeSettingsManager());
		const shelf = await useSettings
			.getState()
			.createSmartShelf("Sci-Fi", filter);

		await expect(
			useSettings.getState().renameSmartShelf(shelf.id, "UNREAD"),
		).rejects.toThrow('A shelf named "UNREAD" already exists');

		expect(
			useSettings.getState().smartShelves.find((s) => s.id === shelf.id)?.name,
		).toBe("Sci-Fi");
	});

	it("renameSmartShelf allows changing only the casing of the same shelf", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);

		// The duplicate check excludes the target shelf, so a case-change
		// rename of the same shelf is allowed.
		await useSettings.getState().renameSmartShelf("builtin-unread", "UNREAD");

		expect(
			useSettings.getState().smartShelves.find((s) => s.id === "builtin-unread")
				?.name,
		).toBe("UNREAD");
		const persisted = await manager.get("smartShelves");
		expect(persisted.find((s) => s.id === "builtin-unread")?.name).toBe(
			"UNREAD",
		);
	});

	it("renameSmartShelf throws for an unknown id", async () => {
		const useSettings = await importStore(createFakeSettingsManager());

		await expect(
			useSettings.getState().renameSmartShelf("no-such-shelf", "Anything"),
		).rejects.toThrow("No shelf with id no-such-shelf");
	});

	it("deleteSmartShelf removes the shelf and persists the removal", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);
		const shelf = await useSettings
			.getState()
			.createSmartShelf("Sci-Fi", filter);

		await useSettings.getState().deleteSmartShelf(shelf.id);

		expect(useSettings.getState().smartShelves).not.toContainEqual(shelf);
		expect(await manager.get("smartShelves")).not.toContainEqual(shelf);
	});

	it("deleting the built-in shelf persists an empty array that survives restart", async () => {
		const manager = createFakeSettingsManager();
		const first = await importStore(manager);

		await first.getState().deleteSmartShelf("builtin-unread");

		expect(first.getState().smartShelves).toEqual([]);
		expect(await manager.get("smartShelves")).toEqual([]);

		// Restart: initialize only seeds missing keys, so the persisted empty
		// array must not be overwritten by the defaults.
		const second = await importStore(manager);
		expect(second.getState().smartShelves).toEqual([]);
	});

	it("deleteSmartShelf is a no-op for an unknown id", async () => {
		const manager = createFakeSettingsManager();
		const setSpy = vi.spyOn(manager, "set");
		const useSettings = await importStore(manager);
		// init persists a one-time settings migration; ignore those writes and
		// assert only on what the delete itself does.
		setSpy.mockClear();

		await useSettings.getState().deleteSmartShelf("no-such-shelf");

		expect(setSpy).not.toHaveBeenCalled();
		expect(useSettings.getState().smartShelves).toHaveLength(1);
	});
});

describe("useSettings library registry", () => {
	const CALIBRE_PATH = "/Users/reader/Books/Calibre Library";

	it("createLibrary registers the folder and returns its Calibre ID", async () => {
		const useSettings = await importStore(createFakeSettingsManager());
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);

		expect(id).toBe(idFor(CALIBRE_PATH));
		expect(await useSettings.getState().createLibrary(CALIBRE_PATH)).toBe(id);
		expect(useSettings.getState().libraryPaths).toEqual([
			{ id, displayName: "Calibre Library", absolutePath: CALIBRE_PATH },
		]);
	});

	it("removeLibrary forgets the library and clears it if it was active", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);
		const other = await useSettings.getState().createLibrary("/Books/Other");
		await useSettings.getState().setActiveLibrary(id);

		await useSettings.getState().removeLibrary(other);
		expect(useSettings.getState().activeLibraryId).toBe(id);

		await useSettings.getState().removeLibrary(id);
		expect(useSettings.getState().libraryPaths).toEqual([]);
		expect(registry.libraries).toEqual([]);
		expect(useSettings.getState().activeLibraryId).toBe("");
		expect(await manager.get("activeLibraryId")).toBe("");
	});

	it("restoreLibrary puts a removed library back in its place", async () => {
		const useSettings = await importStore(createFakeSettingsManager());
		const first = await useSettings.getState().createLibrary(CALIBRE_PATH);
		const second = await useSettings.getState().createLibrary("/Books/Second");
		const third = await useSettings.getState().createLibrary("/Books/Third");

		await useSettings.getState().removeLibrary(second);
		await useSettings.getState().restoreLibrary(second);

		expect(useSettings.getState().libraryPaths.map(({ id }) => id)).toEqual([
			first,
			second,
			third,
		]);
	});

	it("renameLibrary trims the name and stores it in the registry", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);

		await useSettings.getState().renameLibrary(id, "  Main Shelf  ");

		const renamed = useSettings
			.getState()
			.libraryPaths.find((library) => library.id === id);
		expect(renamed?.displayName).toBe("Main Shelf");
		expect(registry.libraries[0]?.displayName).toBe("Main Shelf");
		expect(await manager.get("libraryPaths")).toEqual([]);
	});

	it("renameLibrary is a no-op when the trimmed name is unchanged", async () => {
		const useSettings = await importStore(createFakeSettingsManager());
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);
		const before = useSettings.getState().libraryPaths;

		await useSettings.getState().renameLibrary(id, "  Calibre Library  ");

		expect(useSettings.getState().libraryPaths).toBe(before);
	});

	it("renameLibrary rejects empty and whitespace-only names without changing state", async () => {
		const useSettings = await importStore(createFakeSettingsManager());
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);

		await expect(useSettings.getState().renameLibrary(id, "")).rejects.toThrow(
			"Library name cannot be empty",
		);
		await expect(
			useSettings.getState().renameLibrary(id, "   "),
		).rejects.toThrow("Library name cannot be empty");
		expect(registry.libraries[0]?.displayName).toBe("Calibre Library");
	});

	it("renameLibrary throws for an unknown id", async () => {
		const useSettings = await importStore(createFakeSettingsManager());

		await expect(
			useSettings.getState().renameLibrary("no-such-library", "Anything"),
		).rejects.toThrow("No library with id no-such-library");
	});

	it("a renamed library survives an app restart", async () => {
		const manager = createFakeSettingsManager();
		const first = await importStore(manager);
		const id = await first.getState().createLibrary(CALIBRE_PATH);
		await first.getState().renameLibrary(id, "Main Shelf");

		const second = await importStore(manager);

		expect(
			second.getState().libraryPaths.find((library) => library.id === id)
				?.displayName,
		).toBe("Main Shelf");
	});

	it("imports a legacy settings.json list once, remapping the active library and reporting missing folders", async () => {
		const manager = createFakeSettingsManager();
		await manager.initialize();
		await manager.set("libraryPaths", [
			{ id: "old-1", displayName: "Fiction", absolutePath: "/books/fiction" },
			{ id: "old-2", displayName: "Gone", absolutePath: "/missing/gone" },
		]);
		await manager.set("activeLibraryId", "old-1");

		const useSettings = await importStore(manager);
		const state = useSettings.getState();

		expect(state.libraryPaths).toEqual([
			{
				id: idFor("/books/fiction"),
				displayName: "Fiction",
				absolutePath: "/books/fiction",
			},
		]);
		expect(state.activeLibraryId).toBe(idFor("/books/fiction"));
		expect(
			state.droppedLibraries.map(({ displayName }) => displayName),
		).toEqual(["Gone"]);
		expect(await manager.get("libraryPaths")).toEqual([]);
		expect(await manager.get("activeLibraryId")).toBe(idFor("/books/fiction"));

		const restarted = await importStore(manager);
		expect(restarted.getState().droppedLibraries).toEqual([]);
		expect(restarted.getState().libraryPaths).toHaveLength(1);
	});

	it("clears the active library when the legacy active entry was dropped", async () => {
		const manager = createFakeSettingsManager();
		await manager.initialize();
		await manager.set("libraryPaths", [
			{ id: "old-2", displayName: "Gone", absolutePath: "/missing/gone" },
		]);
		await manager.set("activeLibraryId", "old-2");

		const useSettings = await importStore(manager);

		expect(useSettings.getState().activeLibraryId).toBe("");
		expect(useSettings.getState().libraryPaths).toEqual([]);
	});
});
