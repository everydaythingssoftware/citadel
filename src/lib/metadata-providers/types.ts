import type { BookMetadata, MetadataProvider } from "@/bindings";

/** A provider id, mirroring the Rust `MetadataProvider` serialized union. */
export type ProviderId = MetadataProvider;

/**
 * What a provider can do, so the UI adapts (hides cover slots for cover-less
 * sources, shows a key field only when one is required, etc.) without
 * branching on provider ids.
 */
export interface ProviderCapabilities {
	/** Needs an API key to be usable (Hardcover). */
	requiresKey: boolean;
	/** Can return cover art (Hardcover, Open Library). */
	hasCovers: boolean;
	/** Returns subject headings that map to tags (the library sources). */
	hasSubjects: boolean;
	/** Returns a language code (the MARC sources). */
	hasLanguage: boolean;
	/** Supports free-text search, not just ISBN lookup. */
	supportsFreeTextSearch: boolean;
}

export interface ProviderDescriptor {
	id: ProviderId;
	/** Full name, e.g. "Library of Congress". */
	displayName: string;
	/** A one-line description for the settings row. */
	blurb: string;
	/** Where to learn how to get an API key, for providers that need one. */
	keyHelpUrl?: string;
	capabilities: ProviderCapabilities;
	/** A public URL for a record, or null when none applies. */
	deepLink: (book: BookMetadata) => string | null;
}

/** A provider's runtime config (currently just its key, if any). */
export interface ResolvedProviderConfig {
	apiKey: string;
}

export interface ProviderAdapter {
	descriptor: ProviderDescriptor;
	search: (
		query: string,
		config: ResolvedProviderConfig,
	) => Promise<BookMetadata[]>;
	searchByIsbn: (
		isbn: string,
		config: ResolvedProviderConfig,
	) => Promise<BookMetadata[]>;
	test: (
		config: ResolvedProviderConfig,
	) => Promise<{ ok: boolean; message: string }>;
}
