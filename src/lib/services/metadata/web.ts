import type { ClientOptions } from "openapi-fetch";
import { createCitadelHttpClient } from "@/lib/api/client";
import { CREDENTIAL_HOME, type MetadataService } from "./types";

const unwrap = async <T>(
	request: Promise<{
		data?: T;
		error?: { message: string };
		response: Response;
	}>,
): Promise<T> => {
	const { data, error, response } = await request;
	if (error) throw new Error(error.message);
	if (!response.ok || data === undefined)
		throw new Error(`Metadata request failed (${response.status})`);
	return data;
};

/** Lookups run on the serving Citadel server with the user's own credentials. */
export const createWebMetadataService = (
	options: ClientOptions & { baseUrl: string },
): MetadataService => {
	const client = createCitadelHttpClient(options);
	return {
		credentials: CREDENTIAL_HOME.server,
		search: (provider, q) =>
			unwrap(
				client.GET("/api/metadata/search", {
					params: { query: { provider, q } },
				}),
			),
		byIsbn: (provider, isbn) =>
			unwrap(
				client.GET("/api/metadata/isbn/{isbn}", {
					params: { path: { isbn }, query: { provider } },
				}),
			),
		test: async (provider) => {
			try {
				const status = await unwrap(
					client.POST("/api/metadata/providers/{provider}/test", {
						params: { path: { provider } },
					}),
				);
				return { ok: status.is_valid, message: status.message };
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		availability: async () =>
			(await unwrap(client.GET("/api/metadata/providers"))).map((info) => ({
				provider: info.provider,
				available: info.available,
				reason: info.unavailableReason ?? null,
			})),
	};
};

export const webMetadataService = createWebMetadataService({
	baseUrl: globalThis.location?.origin ?? "http://localhost",
	credentials: "same-origin",
});
