import type { BookUpdate, LibraryAuthor, LibraryBook } from "@/bindings";

export const shortenToChars = (str: string, maxChars: number) =>
	str.length > maxChars ? `${str.substring(0, maxChars)}...` : str;

const resolveAuthors = (
	authorIds: readonly string[],
	knownAuthors: readonly LibraryAuthor[],
): LibraryAuthor[] | null => {
	const byId = new Map(knownAuthors.map((author) => [author.id, author]));
	const resolved: LibraryAuthor[] = [];
	for (const id of authorIds) {
		const author = byId.get(id);
		if (!author) return null;
		resolved.push(author);
	}
	return resolved;
};

/**
 * The book as it should look once `updates` is saved, for optimistic
 * rendering. Best effort: derived fields (sortable title, cover path after a
 * rename) keep their old values until the server's copy replaces this one.
 */
export const projectBookUpdate = (
	book: LibraryBook,
	updates: BookUpdate,
	knownAuthors: readonly LibraryAuthor[],
): LibraryBook => {
	const seriesName = updates.series?.trim();
	const unlinksSeries = seriesName !== undefined && seriesName.length === 0;
	const authorList =
		updates.author_id_list === null
			? null
			: resolveAuthors(updates.author_id_list, knownAuthors);

	return {
		...book,
		title: updates.title ?? book.title,
		author_list: authorList ?? book.author_list,
		tag_list: updates.tag_list ?? book.tag_list,
		is_read: updates.is_read ?? book.is_read,
		description: updates.description ?? book.description,
		language_list: updates.language_list ?? book.language_list,
		series: unlinksSeries ? null : (seriesName ?? book.series),
		series_index: unlinksSeries
			? null
			: (updates.series_index ?? book.series_index),
	};
};
