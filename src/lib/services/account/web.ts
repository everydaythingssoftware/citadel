import type { ClientOptions } from "openapi-fetch";
import { createCitadelHttpClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.generated";
import type { AccountService, ProviderCredentialSummary } from "./types";

type ProviderCredentialInfo = components["schemas"]["ProviderCredentialInfo"];

const fromUnixSeconds = (seconds: number): Date => new Date(seconds * 1000);

const toSummary = (
	info: ProviderCredentialInfo,
): ProviderCredentialSummary => ({
	provider: info.provider,
	displayName: info.displayName,
	accountName: info.accountName,
	createdAt: fromUnixSeconds(info.createdAt),
	verifiedAt:
		info.verifiedAt === null ? null : fromUnixSeconds(info.verifiedAt),
	needsReentry: info.needsReentry,
});

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
		throw new Error(`Account request failed (${response.status})`);
	return data;
};

export const createWebAccountService = (
	options: ClientOptions & { baseUrl: string },
): AccountService => {
	const client = createCitadelHttpClient(options);
	return {
		listProviderCredentials: async () =>
			(await unwrap(client.GET("/api/account/provider-credentials"))).map(
				toSummary,
			),
		saveProviderCredential: async (provider, secret) =>
			toSummary(
				await unwrap(
					client.PUT("/api/account/provider-credentials/{provider}", {
						params: { path: { provider } },
						body: { secret },
					}),
				),
			),
		removeProviderCredential: async (provider) => {
			const { error, response } = await client.DELETE(
				"/api/account/provider-credentials/{provider}",
				{ params: { path: { provider } } },
			);
			if (error && response.status !== 404) throw new Error(error.message);
		},
		testProviderCredential: async (provider) => {
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
	};
};

export const webAccountService = createWebAccountService({
	baseUrl: globalThis.location?.origin ?? "http://localhost",
	credentials: "same-origin",
});
