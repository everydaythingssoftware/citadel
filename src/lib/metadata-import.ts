import type { BookMetadata, BookUpdate } from "@/bindings";

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
	updateBook: (bookId: string, updates: BookUpdate) => Promise<unknown>;
	setBookCoverFromUrl: (bookId: string, url: string) => Promise<void>;
}

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

	if (pending.image_url) {
		await deps.setBookCoverFromUrl(bookId, pending.image_url);
	}
};
