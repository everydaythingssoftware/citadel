import type { BookMetadata, MetadataProvider } from "@/bindings";

/**
 * Where keyed providers' credentials live. `local`: the caller passes the key
 * from settings. `server`: the signed-in user's own key is kept by the server
 * and `apiKey` arguments are ignored.
 */
export const CREDENTIAL_HOME = {
	local: "local",
	server: "server",
} as const;
export type CredentialHome =
	(typeof CREDENTIAL_HOME)[keyof typeof CREDENTIAL_HOME];

export interface ProviderAvailability {
	provider: MetadataProvider;
	available: boolean;
	/** Why the provider can't be used right now, when it can't. */
	reason: string | null;
}

export interface MetadataService {
	readonly credentials: CredentialHome;
	search(
		provider: MetadataProvider,
		query: string,
		apiKey: string,
	): Promise<BookMetadata[]>;
	byIsbn(
		provider: MetadataProvider,
		isbn: string,
		apiKey: string,
	): Promise<BookMetadata[]>;
	test(
		provider: MetadataProvider,
		apiKey: string,
	): Promise<{ ok: boolean; message: string }>;
	/** Which providers the current user can use, as far as the host knows. */
	availability(): Promise<ProviderAvailability[]>;
	/** Where to load a result's cover preview from; Citadel fetches it. */
	coverPreviewUrl(coverId: string): string;
	/** Start fetching a chosen result's full-size cover ahead of applying it. */
	prefetchCover(coverId: string): Promise<void>;
}
