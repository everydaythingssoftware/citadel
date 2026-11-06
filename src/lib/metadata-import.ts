import type { BookMetadata } from "@/bindings";
import { getAdapter } from "@/lib/metadata-providers/registry";
import type { ResolvedProviderConfig } from "@/lib/metadata-providers/types";
import { CoverExpiredError } from "@/lib/services/library/types";

/** A "title firstAuthor" query for a provider search. */
const buildSearchQuery = (title: string, authors: string[]): string => {
	const firstAuthor = authors.find((author) => author.trim().length > 0);
	return [title.trim(), firstAuthor?.trim()]
		.filter((part): part is string => Boolean(part))
		.join(" ");
};

export interface ApplyCoverDeps {
	setBookCoverFromMetadata: (bookId: string, coverId: string) => Promise<void>;
	/** A fresh cover ID for the same record, after the old one expired. */
	refreshCoverId: (book: BookMetadata) => Promise<string | null>;
}

/**
 * Look the record up again at its provider for a fresh cover ID: by ISBN when
 * it has one, otherwise by title and first author.
 */
export const refreshCoverId = async (
	book: BookMetadata,
	config: ResolvedProviderConfig,
): Promise<string | null> => {
	const adapter = getAdapter(book.provider);
	const found = book.isbn
		? await adapter.searchByIsbn(book.isbn, config)
		: await adapter.search(buildSearchQuery(book.title, book.authors), config);
	return (
		found.find((candidate) => candidate.provider_id === book.provider_id)
			?.cover_id ?? null
	);
};

/**
 * Apply a record's cover by its cover ID. An ID that expired while the user
 * was deciding is refreshed once, silently, before giving up.
 */
export const applyMetadataCover = async (
	bookId: string,
	book: BookMetadata,
	deps: ApplyCoverDeps,
): Promise<void> => {
	if (!book.cover_id) return;
	try {
		await deps.setBookCoverFromMetadata(bookId, book.cover_id);
	} catch (error) {
		if (!(error instanceof CoverExpiredError)) throw error;
		const fresh = await deps.refreshCoverId(book);
		if (!fresh) throw error;
		await deps.setBookCoverFromMetadata(bookId, fresh);
	}
};
