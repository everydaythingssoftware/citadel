import type { MetadataProvidersSettings, SettingsSchema } from "./types";

/** The current settings schema version. Bump when the shape changes. */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * v0 -> v1: fold the flat `hardcoverApiKey` / `hardcoverAutoLookup` keys into
 * the provider-aware `metadataProviders` block. Hardcover becomes enabled iff a
 * key was present; the keyless library providers default on.
 */
const migrateV0toV1 = (raw: SettingsSchema): SettingsSchema => {
	const hadHardcoverKey = raw.hardcoverApiKey.trim().length > 0;
	return {
		...raw,
		settingsSchemaVersion: 1,
		metadataProviders: {
			preferenceOrder: ["loc", "dnb", "openlibrary", "hardcover"],
			autoLookupOnImport: raw.hardcoverAutoLookup,
			configs: {
				loc: { enabled: true, apiKey: "" },
				dnb: { enabled: true, apiKey: "" },
				openlibrary: { enabled: true, apiKey: "" },
				hardcover: { enabled: hadHardcoverKey, apiKey: raw.hardcoverApiKey },
			},
		},
	};
};

/** v1 -> v2: add the K10plus provider (keyless, enabled), preserving the user's
 * existing toggles and order. Inserted after DNB, the nearest peer. */
const migrateV1toV2 = (raw: SettingsSchema): SettingsSchema => {
	const previous = raw.metadataProviders;
	if (previous.configs.k10plus) {
		return { ...raw, settingsSchemaVersion: 2 };
	}

	const order = [...previous.preferenceOrder];
	if (!order.includes("k10plus")) {
		const dnbIndex = order.indexOf("dnb");
		const insertAt =
			dnbIndex === -1 ? Math.max(order.length - 1, 0) : dnbIndex + 1;
		order.splice(insertAt, 0, "k10plus");
	}

	const metadataProviders: MetadataProvidersSettings = {
		...previous,
		preferenceOrder: order,
		configs: {
			...previous.configs,
			k10plus: { enabled: true, apiKey: "" },
		},
	};
	return { ...raw, settingsSchemaVersion: 2, metadataProviders };
};

/** v2 -> v3: sharing preferences are seeded by the settings manager from the
 * current defaults. Advancing the version records that the safe, password-free
 * sharing shape is present. */
const migrateV2toV3 = (raw: SettingsSchema): SettingsSchema => ({
	...raw,
	settingsSchemaVersion: 3,
});

/**
 * Bring a loaded settings object up to the current schema version by applying
 * each step in order. Gated on an explicit version, not value-equality with
 * defaults — the very defaults these changes introduce would otherwise make the
 * gate unreliable.
 */
export const migrateSettings = (raw: SettingsSchema): SettingsSchema => {
	let settings = raw;
	if ((settings.settingsSchemaVersion ?? 0) < 1) {
		settings = migrateV0toV1(settings);
	}
	if (settings.settingsSchemaVersion < 2) {
		settings = migrateV1toV2(settings);
	}
	if (settings.settingsSchemaVersion < 3) {
		settings = migrateV2toV3(settings);
	}
	return settings;
};
