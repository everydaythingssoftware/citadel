import type { BookMetadata, BookUpdate } from "@/bindings";
import { getAdapter } from "@/lib/metadata-providers/registry";
import type { ResolvedProviderConfig } from "@/lib/metadata-providers/types";
import { CoverExpiredError } from "@/lib/services/library/types";

/**
 * Metadata resolved for a book that has not been created yet (during import).
 * It is just the unified provider record; the caller applies it after the book
 * is created.
 */
export type PendingMetadata = BookMetadata;

/** Build a "title firstAuthor" query to prefill the search modal. */
export const buildSearchQuery = (title: string, authors: string[]): string => {
	const firstAuthor = authors.find((author) => author.trim().length > 0);
	return [title.trim(), firstAuthor?.trim()]
		.filter((part): part is string => Boolean(part))
		.join(" ");
};

export interface ApplyMetadataDeps {
	upsertBookIdentifier: (
		bookId: string,
		identifierId: number | null,
		label: string,
		value: string,
	) => Promise<void>;
	updateBook: (bookId: string, updates: BookUpdate) => Promise<void>;
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
	deps: Pick<ApplyMetadataDeps, "setBookCoverFromMetadata" | "refreshCoverId">,
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

/**
 * Apply pending metadata to a freshly created book.
 *
 * Does NOT upsert an isbn identifier — the import create path stores the ISBN
 * via ImportableBookMetadata.identifier. Subjects ARE written directly to tags
 * here: the book was just created, so there is nothing to clobber.
 */
export const applyMetadataToBook = async (
	bookId: string,
	pending: BookMetadata,
	deps: ApplyMetadataDeps,
): Promise<void> => {
	const identifierValue = pending.slug ?? pending.provider_id;
	if (identifierValue) {
		await deps.upsertBookIdentifier(
			bookId,
			null,
			pending.identifier_label,
			identifierValue,
		);
	}

	const tagList = pending.subjects.length > 0 ? pending.subjects : null;
	if (pending.description || tagList) {
		await deps.updateBook(bookId, {
			author_id_list: null,
			tag_list: tagList,
			title: null,
			timestamp: null,
			publication_date: null,
			is_read: null,
			description: pending.description,
			series: null,
			series_index: null,
			language_list: null,
		});
	}

	await applyMetadataCover(bookId, pending, deps);
};
