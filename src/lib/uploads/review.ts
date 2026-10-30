import type { ReviewedBook, StagedBook } from "@/lib/services/library";

/** The review card's editable fields, as the inputs hold them. */
export interface ReviewForm {
	title: string;
	authors: string[];
	publisher: string;
	language: string;
	tags: string[];
	/** `YYYY-MM-DD`, or empty. */
	publicationDate: string;
	identifier: string;
}

export const formForBook = (book: StagedBook | undefined): ReviewForm => ({
	title: book?.title ?? "",
	authors: book?.authorNames ?? [],
	publisher: book?.publisher ?? "",
	language: book?.language ?? "",
	tags: book?.tags ?? [],
	publicationDate: book?.publicationDate ?? "",
	identifier: book?.identifier ?? "",
});

const optional = (value: string): string | null => value.trim() || null;

export const isValidDate = (value: string): boolean =>
	value === "" ||
	(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));

/** What a reviewed form commits; blank fields are left out. */
export const reviewedFromForm = (form: ReviewForm): ReviewedBook => ({
	title: form.title.trim(),
	authorNames: form.authors.map((author) => author.trim()).filter(Boolean),
	publisher: optional(form.publisher),
	language: optional(form.language),
	tags: form.tags.map((tag) => tag.trim()).filter(Boolean),
	publicationDate: isValidDate(form.publicationDate.trim())
		? optional(form.publicationDate)
		: null,
	identifier: optional(form.identifier),
});

export const canAddForm = (form: ReviewForm): boolean =>
	form.title.trim() !== "" && isValidDate(form.publicationDate.trim());
