import { createCitadelHttpClient } from "@/lib/api/client";
import { createHttpLibrary } from "../library/http";
import type { LibraryCatalog } from "./types";

const unavailable = async (): Promise<never> => {
	throw new Error("Local library management is unavailable in the browser");
};
export const webLibraryCatalog: LibraryCatalog = {
	open: async (options) => {
		if (options.connectionType !== "remote") return unavailable();
		const url = new URL(options.url);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			throw new Error("Invalid Citadel server URL");
		const clientOptions = {
			baseUrl: url.origin,
			credentials: "same-origin" as const,
		};
		const client = createCitadelHttpClient(clientOptions);
		const { data, error, response } = await client.GET("/api/library");
		if (error || !response.ok || !data)
			throw new Error(
				error?.message ?? `Could not connect to Citadel (${response.status})`,
			);
		return createHttpLibrary(clientOptions, { writable: !data.readOnly });
	},
	create: unavailable,
	isValid: async () => false,
	detect: async () => null,
	defaultNewPath: unavailable,
	stats: unavailable,
	syncStatus: async () => ({ synced: false, provider: null }),
	list: async () => [],
	register: unavailable,
	rename: unavailable,
	importLegacy: unavailable,
	onChange: async () => () => {},
};
