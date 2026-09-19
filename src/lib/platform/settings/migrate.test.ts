import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrateSettings } from "./migrate";
import { defaultSettings, type SettingsSchema } from "./types";

const v0 = (overrides: Partial<SettingsSchema>): SettingsSchema => ({
	...defaultSettings,
	settingsSchemaVersion: 0,
	...overrides,
});

describe("migrateSettings", () => {
	it("migrates a configured Hardcover key into the provider block", () => {
		const result = migrateSettings(
			v0({ hardcoverApiKey: "secret-key", hardcoverAutoLookup: true }),
		);
		expect(result.settingsSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(result.metadataProviders.configs.hardcover).toEqual({
			enabled: true,
			apiKey: "secret-key",
		});
		expect(result.metadataProviders.autoLookupOnImport).toBe(true);
	});

	it("enables the keyless library providers (incl. K10plus) when migrating from v0", () => {
		const result = migrateSettings(v0({ hardcoverApiKey: "" }));
		expect(result.metadataProviders.configs.hardcover?.enabled).toBe(false);
		for (const id of ["loc", "dnb", "k10plus", "openlibrary"] as const) {
			expect(result.metadataProviders.configs[id]?.enabled).toBe(true);
		}
	});

	it("adds K10plus to an already-v1 install, preserving existing toggles", () => {
		const v1: SettingsSchema = {
			...defaultSettings,
			settingsSchemaVersion: 1,
			metadataProviders: {
				preferenceOrder: ["loc", "dnb", "openlibrary", "hardcover"],
				configs: {
					loc: { enabled: false, apiKey: "" }, // user turned LoC off
					dnb: { enabled: true, apiKey: "" },
					openlibrary: { enabled: true, apiKey: "" },
					hardcover: { enabled: true, apiKey: "kept" },
				},
				autoLookupOnImport: true,
			},
		};
		const result = migrateSettings(v1);
		expect(result.settingsSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		// K10plus added and enabled, inserted right after DNB.
		expect(result.metadataProviders.configs.k10plus).toEqual({
			enabled: true,
			apiKey: "",
		});
		expect(result.metadataProviders.preferenceOrder).toEqual([
			"loc",
			"dnb",
			"k10plus",
			"openlibrary",
			"hardcover",
		]);
		// Existing choices untouched.
		expect(result.metadataProviders.configs.loc?.enabled).toBe(false);
		expect(result.metadataProviders.configs.hardcover?.apiKey).toBe("kept");
	});

	it("advances v2 installs without persisting any sharing secret", () => {
		const result = migrateSettings({
			...defaultSettings,
			settingsSchemaVersion: 2,
		});
		expect(result.settingsSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(result.sharing).toEqual({
			target: { type: "allLocalNetworks" },
			port: 8080,
			authenticationEnabled: false,
			username: "",
		});
		expect(JSON.stringify(result.sharing)).not.toMatch(/password|verifier/i);
	});

	it("is a no-op once already at the current version", () => {
		const already: SettingsSchema = {
			...defaultSettings,
			settingsSchemaVersion: CURRENT_SCHEMA_VERSION,
			metadataProviders: {
				preferenceOrder: ["hardcover"],
				configs: { hardcover: { enabled: true, apiKey: "kept" } },
				autoLookupOnImport: true,
			},
		};
		expect(migrateSettings(already)).toBe(already);
	});
});
