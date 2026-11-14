import type { Identifier } from "@/bindings";

interface KnownIdentifier {
	name: string;
	url?: (value: string) => string;
}

const amazon = (value: string) => `https://www.amazon.com/dp/${value}`;

const openLibrary = (value: string) => {
	const kind = value.endsWith("W")
		? "works"
		: value.endsWith("A")
			? "authors"
			: "books";
	return `https://openlibrary.org/${kind}/${encodeURIComponent(value)}`;
};

/** In display order: ISBN first, then the sites people look books up on. */
const KNOWN: Record<string, KnownIdentifier> = {
	isbn: { name: "ISBN" },
	hardcover: { name: "Hardcover" },
	openlibrary: { name: "Open Library", url: openLibrary },
	olid: { name: "Open Library", url: openLibrary },
	goodreads: {
		name: "Goodreads",
		url: (value) => `https://www.goodreads.com/book/show/${value}`,
	},
	amazon: { name: "Amazon", url: amazon },
	asin: { name: "Amazon", url: amazon },
	"mobi-asin": { name: "Amazon", url: amazon },
	google: {
		name: "Google Books",
		url: (value) => `https://books.google.com/books?id=${value}`,
	},
	lccn: {
		name: "LCCN",
		url: (value) => `https://lccn.loc.gov/${encodeURIComponent(value)}`,
	},
	oclc: {
		name: "OCLC",
		url: (value) =>
			`https://www.worldcat.org/oclc/${encodeURIComponent(value)}`,
	},
	dnb: {
		name: "DNB",
		url: (value) => `https://d-nb.info/${encodeURIComponent(value)}`,
	},
	doi: {
		name: "DOI",
		url: (value) => `https://doi.org/${value}`,
	},
	uri: { name: "Link", url: (value) => value },
	url: { name: "Link", url: (value) => value },
};

const ORDER = Object.keys(KNOWN);

const isWebLink = (value: string) => {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
};

/**
 * What people call an identifier's source: "Open Library", not
 * "OPENLIBRARY". Unknown labels of up to four letters read as acronyms
 * ("DOI"); longer ones get a capital first letter.
 */
export const identifierDisplayName = (label: string): string => {
	const known = KNOWN[label.toLowerCase()];
	if (known) return known.name;
	const words = label.replace(/[-_]+/g, " ").trim();
	if (words.length === 0) return "Identifier";
	if (words.length <= 4 && !words.includes(" ")) return words.toUpperCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A web page for the identifier, when its source has one. */
export const identifierUrl = (identifier: Identifier): string | null => {
	const url = KNOWN[identifier.label.toLowerCase()]?.url?.(identifier.value);
	return url !== undefined && isWebLink(url) ? url : null;
};

const rank = (identifier: Identifier): number => {
	const index = ORDER.indexOf(identifier.label.toLowerCase());
	return index === -1 ? ORDER.length : index;
};

/** Known sources first, in a fixed order, so the list reads the same. */
export const sortIdentifiers = (identifiers: Identifier[]): Identifier[] =>
	identifiers.slice().sort((a, b) => rank(a) - rank(b));
