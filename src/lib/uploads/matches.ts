import type { AddTo, BookMatch } from "@/lib/services/library";

/** Longest a book's title runs in a sentence before it is cut short. */
export const TITLE_IN_TEXT_CHARS = 50;

/** A title cut to fit a sentence, at a word where it can. */
export const shortTitle = (
	title: string,
	limit = TITLE_IN_TEXT_CHARS,
): string => {
	const trimmed = title.trim();
	if (trimmed.length <= limit) return trimmed;
	const cut = trimmed.slice(0, limit);
	const space = cut.lastIndexOf(" ");
	return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** Same ISBN, or same title and an author: adding to it is the default. */
export const isStrongMatch = (match: BookMatch): boolean =>
	match.reason === "isbn" || match.reason === "titleAndAuthor";

export const Destination = {
	existing: "existing",
	new: "new",
} as const;
export type TDestination = (typeof Destination)[keyof typeof Destination];

/** Where a book goes unless the person says otherwise. */
export const defaultDestination = (matches: BookMatch[]): TDestination =>
	matches.some(isStrongMatch) ? Destination.existing : Destination.new;

/** The match chosen by default: the strongest, which the list puts first. */
export const defaultMatch = (matches: BookMatch[]): BookMatch | undefined =>
	matches[0];

export const addToFor = (
	destination: TDestination,
	match: BookMatch | undefined,
): AddTo =>
	destination === Destination.existing && match
		? { kind: "existingBook", bookId: match.id }
		: { kind: "newBook" };

/**
 * What the add button says: a new book, another format of the chosen one,
 * or replacing the format it already has.
 */
export const addLabel = (
	destination: TDestination,
	match: BookMatch | undefined,
	formats: readonly string[],
	hasMatches: boolean,
): string => {
	if (!hasMatches) return "Add to Library";
	if (destination === Destination.new || !match) return "Add as New Book";
	const replaced = formats.filter((format) => match.formats.includes(format));
	if (replaced.length === 1 && formats.length === 1)
		return `Replace ${replaced[0]}`;
	return replaced.length > 0 ? "Combine and Replace" : "Combine Books";
};
