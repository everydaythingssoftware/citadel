import type { MetadataProvider } from "@/bindings";

// Owned here (not in the library-view store) so the platform settings layer
// never depends on the stores layer; the store re-exports it.
export type LibraryBookSortOrderKey =
	| "nameAz"
	| "nameZa"
	| "authorAz"
	| "authorZa";

export interface LibraryPath {
	id: string;
	displayName: string;
	absolutePath: string;
}

export interface SmartShelfFilter {
	query: string;
	sortOrder: LibraryBookSortOrderKey;
	hideRead: boolean;
}

export interface SmartShelf {
	id: string;
	name: string;
	filter: SmartShelfFilter;
}

/** Per-provider configuration. `apiKey` is unused by the keyless providers. */
export interface ProviderConfig {
	enabled: boolean;
	apiKey: string;
}

export interface MetadataProvidersSettings {
	/** Providers in the user's preference order (winner-takes-all on dedupe). */
	preferenceOrder: MetadataProvider[];
	configs: Partial<Record<MetadataProvider, ProviderConfig>>;
	/** Auto-look-up metadata when importing a file that carries an ISBN. */
	autoLookupOnImport: boolean;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
/** Where the OPDS server listens. `allInterfaces` additionally requires
 * credentials (see the sharing pane); `localNetworks` never does. */
export type SharingTarget = "localNetworks" | "allInterfaces";

export interface SharingSettings {
	target: SharingTarget;
	port: number;
	authenticationEnabled: boolean;
	username: string;
}

export interface SettingsSchema {
	theme: "dark" | "light" | "auto";
	startFullscreen: boolean;
	autoUpdateCheckingEnabled: boolean;
	hasCompletedFirstLaunch: boolean;
	activeLibraryId: string;
	libraryPaths: LibraryPath[];
	/** @deprecated Read once at migration into `metadataProviders`; not written. */
	hardcoverApiKey: string;
	/** @deprecated Read once at migration into `metadataProviders`; not written. */
	hardcoverAutoLookup: boolean;
	lastNotifiedUpdateVersion: string | null;
	smartShelves: SmartShelf[];
	/** Bumped when the settings shape changes; gates one-time migrations. */
	settingsSchemaVersion: number;
	metadataProviders: MetadataProvidersSettings;
	sharing: SharingSettings;
}

export const defaultSettings: SettingsSchema = {
	theme: "auto",
	startFullscreen: false,
	autoUpdateCheckingEnabled: true,
	hasCompletedFirstLaunch: false,
	activeLibraryId: "",
	libraryPaths: [],
	hardcoverApiKey: "",
	hardcoverAutoLookup: false,
	lastNotifiedUpdateVersion: null,
	smartShelves: [
		{
			id: "builtin-unread",
			name: "Unread",
			filter: { query: "", sortOrder: "authorAz", hideRead: true },
		},
	],
	// Starts at 0 (the unmigrated sentinel) so the one-time migration runs once
	// on every existing install; new installs migrate harmlessly from defaults.
	settingsSchemaVersion: 0,
	metadataProviders: {
		preferenceOrder: ["loc", "dnb", "k10plus", "openlibrary", "hardcover"],
		configs: {
			loc: { enabled: true, apiKey: "" },
			dnb: { enabled: true, apiKey: "" },
			k10plus: { enabled: true, apiKey: "" },
			openlibrary: { enabled: true, apiKey: "" },
			hardcover: { enabled: false, apiKey: "" },
		},
		autoLookupOnImport: false,
	},
	sharing: {
		target: "localNetworks",
		port: 9028,
		authenticationEnabled: false,
		username: "",
	},
};

export type SettingsKey = keyof SettingsSchema;
export type SettingsValue<K extends SettingsKey> = SettingsSchema[K];

export interface SettingsManager {
	initialize: () => Promise<SettingsSchema>;
	set: <K extends SettingsKey>(
		key: K,
		value: SettingsValue<K>,
	) => Promise<void>;
	get: <K extends SettingsKey>(key: K) => Promise<SettingsValue<K>>;
	/**
	 * Fires for every persisted change, including ones made from other windows
	 * sharing the same backing store. Returns an unsubscribe function.
	 */
	onChange?: (
		callback: (key: SettingsKey, value: SettingsSchema[SettingsKey]) => void,
	) => Promise<() => void>;
}
