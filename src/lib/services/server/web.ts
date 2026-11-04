import type { ClientOptions } from "openapi-fetch";
import { createCitadelHttpClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.generated";
import type { ServerService, ServerUpdate } from "./types";

type UpdateStatus = components["schemas"]["UpdateStatus"];

const dateOrNull = (value: string | null | undefined): Date | null =>
	value ? new Date(value) : null;

const toUpdate = (status: UpdateStatus): ServerUpdate => ({
	currentVersion: status.currentVersion,
	checks: status.checks,
	available: status.available
		? {
				version: status.available.version,
				url: status.available.url,
				publishedAt: dateOrNull(status.available.publishedAt),
			}
		: null,
	checkedAt: dateOrNull(status.checkedAt),
});

export const createWebServerService = (
	options: ClientOptions & { baseUrl: string },
): ServerService => {
	const client = createCitadelHttpClient(options);
	return {
		version: async () => {
			const { data, response } = await client.GET("/api/version");
			if (!data)
				throw new Error(`Could not reach Citadel (${response.status})`);
			return data;
		},
		update: async () => {
			const { data, error, response } = await client.GET("/api/server/update");
			if (response.status === 401 || response.status === 403) return null;
			if (error || !data)
				throw new Error(
					error?.message ?? `Could not check for updates (${response.status})`,
				);
			return toUpdate(data);
		},
	};
};

export const webServerService = createWebServerService({
	baseUrl: globalThis.location?.origin ?? "http://localhost",
	credentials: "same-origin",
});
