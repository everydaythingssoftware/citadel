import { create } from "zustand";
import type { MetadataProvider } from "@/bindings";
import type { Option } from "@/lib/option";
import { none, some } from "@/lib/option";
import { migrateSettings } from "@/lib/platform/settings/migrate";
import {
	defaultSettings,
	type LibraryPath,
	type ProviderConfig,
	type SettingsKey,
	type SettingsManager,
	type SettingsSchema,
	type SettingsValue,
	type SharingSettings,
	type SmartShelf,
	type SmartShelfFilter,
} from "@/lib/platform/settings/types";
import { libraryCatalog } from "@/lib/services/library-catalog";

interface SettingsStore extends SettingsSchema {
	hydrated: boolean;
	settingsManager: SettingsManager | null;
	/** Legacy settings.json libraries that no longer exist; shown once. */
	droppedLibraries: LibraryPath[];

	// Lifecycle
	init: (settingsManager: SettingsManager) => Promise<void>;

	// Domain-specific actions
	setTheme: (theme: "dark" | "light" | "auto") => Promise<void>;
	setStartFullscreen: (enabled: boolean) => Promise<void>;
	setAutoUpdateCheckingEnabled: (enabled: boolean) => Promise<void>;
	setHasCompletedFirstLaunch: (enabled: boolean) => Promise<void>;
	setActiveLibrary: (libraryId: string) => Promise<void>;
	setSharing: (sharing: SharingSettings) => Promise<void>;
	createLibrary: (absolutePath: string) => Promise<string>;
	renameLibrary: (id: string, displayName: string) => Promise<void>;
	/** Forgets a library; clears the active library if it was this one. */
	removeLibrary: (id: string) => Promise<void>;
	/** Undoes removeLibrary: the library returns to its place in the list. */
	restoreLibrary: (id: string) => Promise<void>;
	getActiveLibrary: () => Option<LibraryPath>;
	setProviderConfig: (
		id: MetadataProvider,
		patch: Partial<ProviderConfig>,
	) => Promise<void>;
	setProviderEnabled: (id: MetadataProvider, enabled: boolean) => Promise<void>;
	setAutoLookupOnImport: (enabled: boolean) => Promise<void>;
	setLastNotifiedUpdateVersion: (version: string | null) => Promise<void>;
	createSmartShelf: (
		name: string,
		filter: SmartShelfFilter,
	) => Promise<SmartShelf>;
	renameSmartShelf: (id: string, name: string) => Promise<void>;
	deleteSmartShelf: (id: string) => Promise<void>;
}

const validateShelfName = (name: string, otherShelves: SmartShelf[]) => {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		throw new Error("Shelf name cannot be empty");
	}
	const lowered = trimmed.toLowerCase();
	if (otherShelves.some((shelf) => shelf.name.toLowerCase() === lowered)) {
		throw new Error(`A shelf named "${trimmed}" already exists`);
	}
	return trimmed;
};

const upsertLibrary = (libraries: LibraryPath[], library: LibraryPath) =>
	libraries.some(({ id }) => id === library.id)
		? libraries.map((existing) =>
				existing.id === library.id ? library : existing,
			)
		: [...libraries, library];

/**
 * The library list lives in citadel.db (ADR 0009). A list still in
 * settings.json is imported once, keyed by Calibre UUID; entries whose folder
 * is gone are dropped and reported.
 */
const loadLibraries = async (
	settingsManager: SettingsManager,
	settings: SettingsSchema,
): Promise<
	Pick<SettingsStore, "libraryPaths" | "activeLibraryId" | "droppedLibraries">
> => {
	if (settings.libraryPaths.length === 0)
		return {
			libraryPaths: await libraryCatalog.list(),
			activeLibraryId: settings.activeLibraryId,
			droppedLibraries: [],
		};
	const result = await libraryCatalog.importLegacy(settings.libraryPaths);
	const activeLibraryId =
		result.idChanges.find(
			({ previousId }) => previousId === settings.activeLibraryId,
		)?.id ?? "";
	await settingsManager.set("activeLibraryId", activeLibraryId);
	await settingsManager.set("libraryPaths", []);
	return {
		libraryPaths: result.libraries,
		activeLibraryId,
		droppedLibraries: result.dropped,
	};
};

const setSetting = <K extends SettingsKey>(
	target: SettingsSchema,
	key: K,
	value: SettingsValue<K>,
) => {
	target[key] = value;
};

// Helper to update store and persist to disk
const persistSetting = async <K extends SettingsKey>(
	set: (partial: Partial<SettingsStore>) => void,
	get: () => SettingsStore,
	key: K,
	value: SettingsValue<K>,
) => {
	const { settingsManager } = get();
	if (!settingsManager) {
		throw new Error("Settings manager not initialized");
	}

	// Update store immediately for responsive UI
	set({ [key]: value } as Partial<SettingsStore>);

	// Persist to disk
	await settingsManager.set(key, value);
};

export const useSettings = create<SettingsStore>((set, get) => ({
	...defaultSettings,
	hydrated: false,
	settingsManager: null,
	droppedLibraries: [],

	init: async (settingsManager: SettingsManager) => {
		set({ settingsManager });
		try {
			await settingsManager.initialize();

			// Load all settings from manager
			const initialSettings = {} as SettingsSchema;
			for (const key of Object.keys(defaultSettings) as SettingsKey[]) {
				const value = await settingsManager.get(key);
				setSetting(initialSettings, key, value);
			}

			// One-time schema migration (e.g. flat Hardcover keys -> provider
			// block). Persist only when the version actually advanced.
			const migrated = migrateSettings(initialSettings);
			const libraries = await loadLibraries(settingsManager, migrated).catch(
				(error: unknown) => {
					console.error("Failed to load libraries:", error);
					return { libraryPaths: [], droppedLibraries: [] };
				},
			);
			set({ ...migrated, ...libraries, hydrated: true });
			if (
				migrated.settingsSchemaVersion !== initialSettings.settingsSchemaVersion
			) {
				await settingsManager.set(
					"metadataProviders",
					migrated.metadataProviders,
				);
				await settingsManager.set(
					"settingsSchemaVersion",
					migrated.settingsSchemaVersion,
				);
			}

			// Mirror changes persisted by other windows (e.g. the Settings
			// window changing theme or the active library) into this window's
			// store. Receiving never re-persists, so there is no echo loop.
			void settingsManager.onChange?.((key, value) => {
				// The library list is citadel.db's; settings.json only ever
				// holds the emptied legacy key.
				if (key === "libraryPaths" || Object.is(get()[key], value)) return;
				set({ [key]: value } as Partial<SettingsStore>);
			});
			void libraryCatalog.onChange((libraryPaths) => set({ libraryPaths }));
		} catch (e) {
			console.error("Failed to initialize settings:", e);
		}
	},

	setTheme: async (theme) => {
		await persistSetting(set, get, "theme", theme);
	},

	setStartFullscreen: async (enabled) => {
		await persistSetting(set, get, "startFullscreen", enabled);
	},

	setAutoUpdateCheckingEnabled: async (enabled) => {
		await persistSetting(set, get, "autoUpdateCheckingEnabled", enabled);
	},

	setHasCompletedFirstLaunch: async (enabled) => {
		await persistSetting(set, get, "hasCompletedFirstLaunch", enabled);
	},

	setActiveLibrary: async (libraryId) => {
		await persistSetting(set, get, "activeLibraryId", libraryId);
	},

	createLibrary: async (absolutePath) => {
		const library = await libraryCatalog.register(absolutePath);
		set({ libraryPaths: upsertLibrary(get().libraryPaths, library) });
		return library.id;
	},

	renameLibrary: async (id, displayName) => {
		const target = get().libraryPaths.find((library) => library.id === id);
		if (!target) {
			throw new Error(`No library with id ${id}`);
		}

		const trimmed = displayName.trim();
		if (trimmed.length === 0) {
			throw new Error("Library name cannot be empty");
		}
		if (trimmed === target.displayName) return;

		const library = await libraryCatalog.rename(id, trimmed);
		set({ libraryPaths: upsertLibrary(get().libraryPaths, library) });
	},

	removeLibrary: async (id) => {
		await libraryCatalog.remove(id);
		set({
			libraryPaths: get().libraryPaths.filter((library) => library.id !== id),
		});
		if (get().activeLibraryId === id) {
			await persistSetting(set, get, "activeLibraryId", "");
		}
	},

	restoreLibrary: async (id) => {
		await libraryCatalog.restore(id);
		// The registry's order, not an append: the library goes back exactly
		// where it was.
		set({ libraryPaths: await libraryCatalog.list() });
	},

	getActiveLibrary: () => {
		const { activeLibraryId, libraryPaths } = get();
		const activeLibrary = libraryPaths.find(
			(library) => library.id === activeLibraryId,
		);

		if (activeLibrary === undefined) return none();

		return some(activeLibrary);
	},

	setProviderConfig: async (id, patch) => {
		const current = get().metadataProviders;
		const existing = current.configs[id] ?? { enabled: false, apiKey: "" };
		await persistSetting(set, get, "metadataProviders", {
			...current,
			configs: { ...current.configs, [id]: { ...existing, ...patch } },
		});
	},

	setProviderEnabled: async (id, enabled) => {
		await get().setProviderConfig(id, { enabled });
	},

	setAutoLookupOnImport: async (enabled) => {
		const current = get().metadataProviders;
		await persistSetting(set, get, "metadataProviders", {
			...current,
			autoLookupOnImport: enabled,
		});
	},

	setLastNotifiedUpdateVersion: async (version) => {
		await persistSetting(set, get, "lastNotifiedUpdateVersion", version);
	},

	setSharing: async (sharing) => {
		await persistSetting(set, get, "sharing", sharing);
	},

	createSmartShelf: async (name, filter) => {
		const { smartShelves } = get();
		const trimmed = validateShelfName(name, smartShelves);
		const shelf: SmartShelf = {
			id: uuidv4(),
			name: trimmed,
			filter: { ...filter },
		};

		await persistSetting(set, get, "smartShelves", [...smartShelves, shelf]);

		return shelf;
	},

	renameSmartShelf: async (id, name) => {
		const { smartShelves } = get();
		const target = smartShelves.find((shelf) => shelf.id === id);
		if (!target) {
			throw new Error(`No shelf with id ${id}`);
		}

		const otherShelves = smartShelves.filter((shelf) => shelf.id !== id);
		const trimmed = validateShelfName(name, otherShelves);

		await persistSetting(
			set,
			get,
			"smartShelves",
			smartShelves.map((shelf) =>
				shelf.id === id ? { ...shelf, name: trimmed } : shelf,
			),
		);
	},

	deleteSmartShelf: async (id) => {
		const { smartShelves } = get();
		if (!smartShelves.some((shelf) => shelf.id === id)) {
			return;
		}

		await persistSetting(
			set,
			get,
			"smartShelves",
			smartShelves.filter((shelf) => shelf.id !== id),
		);
	},
}));

// TODO: Replace this with a proper UUID generator
const uuidv4 = () => {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
};

// Custom hook - derives Option from primitives to avoid reference equality issues
export const useActiveLibraryPath = (): Option<string> => {
	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const libraryPaths = useSettings((state) => state.libraryPaths);

	// Derive Option inline - React only re-renders if dependencies change
	if (!activeLibraryId || activeLibraryId.length === 0) {
		return none();
	}

	const activeLibrary = libraryPaths.find(
		(library) => library.id === activeLibraryId,
	);

	if (activeLibrary?.absolutePath) {
		return some(activeLibrary.absolutePath);
	}

	return none();
};
