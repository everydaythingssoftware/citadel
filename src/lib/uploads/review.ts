import { formatIsbn, isbnProblem, normalizeIsbn } from "@/lib/isbn";
import {
	codeForLanguageName,
	KNOWN_LANGUAGE_NAMES,
	languageNameForCode,
} from "@/lib/languages";
import type { ReviewedBook, StagedBook } from "@/lib/services/library";

/** The review card's editable fields, as the inputs hold them. */
export interface ReviewForm {
	title: string;
	authors: string[];
	publisher: string;
	/** The language's English name ("French"), or what was typed. */
	language: string;
	tags: string[];
	/** `YYYY-MM-DD`, or empty. */
	publicationDate: string;
	/** As typed; hyphenated once it's a valid ISBN. */
	identifier: string;
}

export type ReviewField = keyof ReviewForm;

const displayNames = (() => {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" });
	} catch {
		return undefined;
	}
})();

/**
 * A language name for a code read from a file. EPUBs usually carry BCP 47
 * tags ("en", "fr-CA") while Calibre stores ISO 639-3 ("eng").
 */
export const languageNameForFileCode = (code: string): string => {
	const trimmed = code.trim();
	if (trimmed === "") return "";
	const known = languageNameForCode(trimmed);
	if (KNOWN_LANGUAGE_NAMES.includes(known)) return known;
	const primary = trimmed.split(/[-_]/)[0] ?? trimmed;
	try {
		const name = displayNames?.of(primary);
		if (name && name.toLowerCase() !== primary.toLowerCase()) return name;
	} catch {
		// Not a language tag Intl recognizes; keep what the file said.
	}
	return known;
};

export const formForBook = (book: StagedBook | undefined): ReviewForm => ({
	title: book?.title ?? "",
	authors: book?.authorNames ?? [],
	publisher: book?.publisher ?? "",
	language: languageNameForFileCode(book?.language ?? ""),
	tags: book?.tags ?? [],
	publicationDate: book?.publicationDate ?? "",
	// Files often carry other identifiers (UUIDs, URLs); only ISBNs belong here.
	identifier: formatIsbn(book?.identifier ?? "") ?? "",
});

const optional = (value: string): string | null => value.trim() || null;

export const isValidDate = (value: string): boolean =>
	value === "" ||
	(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));

/** What's wrong with a field, if anything. */
export const fieldProblem = (
	form: ReviewForm,
	field: ReviewField,
): string | undefined => {
	switch (field) {
		case "title":
			return form.title.trim() === "" ? "A book needs a title" : undefined;
		case "publicationDate":
			return isValidDate(form.publicationDate.trim())
				? undefined
				: "Use a full date";
		case "identifier":
			return isbnProblem(form.identifier);
		default:
			return undefined;
	}
};

/** Tidies a field once it's left: an ISBN gets its hyphens. */
export const tidyField = (
	form: ReviewForm,
	field: ReviewField,
): Partial<ReviewForm> => {
	if (field === "identifier") {
		const formatted = formatIsbn(form.identifier);
		return formatted && formatted !== form.identifier
			? { identifier: formatted }
			: {};
	}
	return {};
};

/** What a reviewed form commits; blank fields are left out. */
export const reviewedFromForm = (form: ReviewForm): ReviewedBook => ({
	title: form.title.trim(),
	authorNames: form.authors.map((author) => author.trim()).filter(Boolean),
	publisher: optional(form.publisher),
	language: form.language.trim() ? codeForLanguageName(form.language) : null,
	tags: form.tags.map((tag) => tag.trim()).filter(Boolean),
	publicationDate: isValidDate(form.publicationDate.trim())
		? optional(form.publicationDate)
		: null,
	identifier: formatIsbn(form.identifier)
		? (normalizeIsbn(form.identifier.replace(/^urn:isbn:/i, "")) ?? null)
		: null,
});

const FIELDS: ReviewField[] = ["title", "publicationDate", "identifier"];

export const canAddForm = (form: ReviewForm): boolean =>
	FIELDS.every((field) => fieldProblem(form, field) === undefined);
