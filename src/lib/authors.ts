import type { LibraryAuthor } from "@/bindings";

/**
 * Formats a list of authors as one string that can be displayed to a user.
 * @param authors
 * @returns
 *
 * @example
 * ```tsx
 * const authors = [
 *  { name: "Tris NoBoilerplate" },
 *  { name: "Robert Pirzig" }
 * ];
 * formatAuthorList(authors); // "Tris NoBoilerplate, Robert Pirzig"
 * ```
 */
export const formatAuthorList = (authors: LibraryAuthor[]) => {
	return authors.map((author) => author.name).join(", ");
};

/**
 * A short byline for a list of names, APA style: one or two names in full
 * ("Homer", "Homer and Robert Fagles"), three or more as the first "et al.".
 */
export const shortAuthorNames = (names: readonly string[]): string => {
	const [first, second] = names;
	if (!first) return "";
	if (names.length === 1) return first;
	if (names.length === 2) return `${first} and ${second}`;
	return `${first} et al.`;
};
