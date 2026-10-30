import type { MetadataProvider } from "@/bindings";

/** A saved provider key, described without the key itself. */
export interface ProviderCredentialSummary {
	provider: MetadataProvider;
	displayName: string;
	/** The provider account the key belongs to, when the provider says. */
	accountName: string | null;
	createdAt: Date;
	verifiedAt: Date | null;
	/** The server can no longer read the key; it has to be entered again. */
	needsReentry: boolean;
}

/** The signed-in user's own settings on a Citadel server. */
export interface AccountService {
	listProviderCredentials(): Promise<ProviderCredentialSummary[]>;
	/** Checks the key with the provider, then saves it. */
	saveProviderCredential(
		provider: MetadataProvider,
		secret: string,
	): Promise<ProviderCredentialSummary>;
	removeProviderCredential(provider: MetadataProvider): Promise<void>;
	testProviderCredential(
		provider: MetadataProvider,
	): Promise<{ ok: boolean; message: string }>;
}
