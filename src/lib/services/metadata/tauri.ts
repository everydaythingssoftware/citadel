import type { MetadataProvider } from "@/bindings";
import { commands } from "@/bindings";
import { appSchemeUrl } from "@/lib/platform/runtime";
import { CREDENTIAL_HOME, type MetadataService } from "./types";
const PROVIDERS: MetadataProvider[] = [
	"loc",
	"dnb",
	"k10plus",
	"openlibrary",
	"hardcover",
];
const unwrap = <T>(
	result: { status: "ok"; data: T } | { status: "error"; error: string },
): T => {
	if (result.status === "error") throw new Error(result.error);
	return result.data;
};
export const tauriMetadataService: MetadataService = {
	credentials: CREDENTIAL_HOME.local,
	search: async (provider, query, key) =>
		unwrap(await commands.clbQueryMetadataSearch(provider, query, key)),
	byIsbn: async (provider, isbn, key) =>
		unwrap(await commands.clbQueryMetadataByIsbn(provider, isbn, key)),
	test: async (provider, key) => {
		const result = await commands.clbCmdTestMetadataProvider(provider, key);
		return result.status === "ok"
			? { ok: result.data.is_valid, message: result.data.message }
			: { ok: false, message: result.error };
	},
	// Keys live in local settings, which decide availability on the desktop.
	availability: async () =>
		PROVIDERS.map((provider) => ({ provider, available: true, reason: null })),
	// Served by the `citadel-cover` URI scheme from the shared cover cache.
	coverPreviewUrl: (coverId) => appSchemeUrl("citadel-cover", coverId),
	prefetchCover: async (coverId) => {
		unwrap(await commands.clbCmdPrefetchMetadataCover(coverId));
	},
};
