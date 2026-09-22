import {
	defaultSettings,
	type SettingsKey,
	type SettingsManager,
	type SettingsSchema,
	type SettingsValue,
	type SmartShelfFilter,
} from "@/lib/platform/settings/types";
import { describe, expect, it, vi } from "vitest";

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

describe("useSettings library rename", () => {
	const CALIBRE_PATH = "/Users/reader/Books/Calibre Library";

	it("renameLibrary trims the name and persists it", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);

		await useSettings.getState().renameLibrary(id, "  Main Shelf  ");

		const renamed = useSettings
			.getState()
			.libraryPaths.find((library) => library.id === id);
		expect(renamed?.displayName).toBe("Main Shelf");

		const persisted = await manager.get("libraryPaths");
		expect(persisted).toContainEqual({
			id,
			displayName: "Main Shelf",
			absolutePath: CALIBRE_PATH,
		});
	});

	it("renameLibrary is a no-op (no persist) when the trimmed name is unchanged", async () => {
		const manager = createFakeSettingsManager();
		const setSpy = vi.spyOn(manager, "set");
		const useSettings = await importStore(manager);
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);
		setSpy.mockClear();

		await useSettings.getState().renameLibrary(id, "  Calibre Library  ");

		expect(setSpy).not.toHaveBeenCalled();
		expect(useSettings.getState().libraryPaths).toHaveLength(1);
	});

	it("renameLibrary rejects empty and whitespace-only names without changing state", async () => {
		const manager = createFakeSettingsManager();
		const useSettings = await importStore(manager);
		const id = await useSettings.getState().createLibrary(CALIBRE_PATH);

		await expect(useSettings.getState().renameLibrary(id, "")).rejects.toThrow(
			"Library name cannot be empty",
		);
		await expect(
			useSettings.getState().renameLibrary(id, "   "),
		).rejects.toThrow("Library name cannot be empty");

		const persisted = await manager.get("libraryPaths");
		expect(persisted).toContainEqual({
			id,
			displayName: "Calibre Library",
			absolutePath: CALIBRE_PATH,
		});
	});

	it("renameLibrary throws for an unknown id", async () => {
		const useSettings = await importStore(createFakeSettingsManager());

		await expect(
			useSettings.getState().renameLibrary("no-such-library", "Anything"),
		).rejects.toThrow("No library with id no-such-library");
	});

	it("a renamed library survives an app restart with the same manager", async () => {
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
});
