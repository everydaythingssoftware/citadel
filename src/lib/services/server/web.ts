import type { ClientOptions } from "openapi-fetch";
import { createCitadelHttpClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.generated";
import type { ServerHealth, ServerService, ServerUpdate } from "./types";

type UpdateStatus = components["schemas"]["UpdateStatus"];

const dateOrNull = (value: string | null | undefined): Date | null =>
	value ? new Date(value) : null;

const toUpdate = ({ currentVersion, details }: UpdateStatus): ServerUpdate => ({
	currentVersion,
	details: details
		? {
				checks: details.checks,
				available: details.available
					? {
							version: details.available.version,
							url: details.available.url,
							publishedAt: dateOrNull(details.available.publishedAt),
						}
					: null,
				checkedAt: dateOrNull(details.checkedAt),
			}
		: null,
});

export const createWebServerService = (
	options: ClientOptions & { baseUrl: string },
): ServerService => {
	const client = createCitadelHttpClient(options);
	return {
		update: async () => {
			const { data, error, response } = await client.GET("/api/server/update");
			if (response.status === 401) return null;
			if (error || !data)
				throw new Error(
					error?.message ?? `Could not check for updates (${response.status})`,
				);
			return toUpdate(data);
		},
		health: async () => {
			// 503 still carries the checks: that is when they matter most.
			const { data, error, response } = await client.GET("/api/health");
			const health = data ?? (error as unknown as ServerHealth | undefined);
			if (!health?.checks)
				throw new Error(
					`Could not read the server's health (${response.status})`,
				);
			return health;
		},
		addresses: async () => {
			const { data, error, response } = await client.GET(
				"/api/server/addresses",
			);
			if (error || !data)
				throw new Error(
					error?.message ?? `Could not read the addresses (${response.status})`,
				);
			return data;
		},
	};
};

export const webServerService = createWebServerService({
	baseUrl: globalThis.location?.origin ?? "http://localhost",
	credentials: "same-origin",
});
