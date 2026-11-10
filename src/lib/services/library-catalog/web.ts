import { createCitadelHttpClient } from "@/lib/api/client";
import { createHttpLibrary } from "../library/http";
import type { LibraryCatalog, LibrarySetupOperations } from "./types";

const unavailable = async (): Promise<never> => {
	throw new Error("Local library management is unavailable in the browser");
};

/** The server's error message, or a plain one when the answer had none. */
const unwrap = <TData>(
	result: {
		data?: TData;
		error?: { message?: string };
		response: Response;
	},
	fallback: string,
): TData => {
	const { data, error, response } = result;
	if (error || data === undefined)
		throw new Error(error?.message ?? `${fallback} (${response.status})`);
	return data;
};

const clientOptions = (origin: string) => ({
	baseUrl: origin,
	credentials: "same-origin" as const,
});

/** Setup routes on the serving origin; the session cookie carries authority. */
export const createWebLibrarySetup = (
	origin: string,
): LibrarySetupOperations => {
	const client = createCitadelHttpClient(clientOptions(origin));
	return {
		status: async () =>
			unwrap(
				await client.GET("/api/setup/library"),
				"Could not read the library setup",
			),
		inspect: async (path) =>
			unwrap(
				await client.POST("/api/setup/library/inspect", { body: { path } }),
				"Could not inspect that folder",
			),
		listDirectory: async (path) =>
			unwrap(
				await client.GET("/api/setup/directories", {
					params: { query: path === undefined ? {} : { path } },
				}),
				"Could not list that folder",
			),
		choose: async (request) =>
			unwrap(
				await client.POST("/api/setup/library", { body: request }),
				"Could not set the library up",
			),
		reopen: async () =>
			unwrap(
				await client.POST("/api/setup/library/reopen"),
				"Could not reopen the library",
			),
		upgrade: async () =>
			unwrap(
				await client.POST("/api/setup/library/upgrade"),
				"Could not upgrade the library",
			),
	};
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
		const client = createCitadelHttpClient(clientOptions(url.origin));
		const { data, error, response } = await client.GET("/api/library");
		if (error || !response.ok || !data)
			throw new Error(
				error?.message ?? `Could not connect to Citadel (${response.status})`,
			);
		return createHttpLibrary(clientOptions(url.origin), {
			writable: !data.readOnly,
		});
	},
	create: unavailable,
	isValid: async () => false,
	detect: async () => null,
	defaultNewPath: unavailable,
	inspectFolder: unavailable,
	stats: unavailable,
	syncStatus: async () => ({ synced: false, provider: null }),
	list: async () => [],
	register: unavailable,
	rename: unavailable,
	remove: unavailable,
	restore: unavailable,
	importLegacy: unavailable,
	onChange: async () => () => {},
	setup: createWebLibrarySetup(
		typeof window === "undefined" ? "http://localhost" : window.location.origin,
	),
};
