export const normalizeIsbn = (raw: string): string | undefined => {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	const withoutPrefix = trimmed.toLowerCase().startsWith("isbn:")
		? trimmed.slice("isbn:".length).trim()
		: trimmed;

	const compact = withoutPrefix.replace(/[^0-9xX]/g, "").toUpperCase();
	if (/^\d{13}$/.test(compact)) return compact;
	if (/^\d{9}[\dX]$/.test(compact)) return compact;
	return undefined;
};

/**
 * Canonicalize any valid ISBN to its 13-digit form, so the ISBN-10 and ISBN-13
 * representations of one edition compare equal. Returns undefined for invalid
 * input. (Fuzzy provider-side matching stays in Rust; this is only for
 * display-side dedupe and pinning, where a file may carry an ISBN-10.)
 */
export const toIsbn13 = (raw: string): string | undefined => {
	const normalized = normalizeIsbn(raw);
	if (!normalized) return undefined;
	if (normalized.length === 13) return normalized;

	const core = `978${normalized.slice(0, 9)}`;
	let sum = 0;
	for (let i = 0; i < 12; i += 1) {
		const digit = core.charCodeAt(i) - 48;
		sum += i % 2 === 0 ? digit : digit * 3;
	}
	const check = (10 - (sum % 10)) % 10;
	return `${core}${check}`;
};

/**
 * Whether two ISBN strings denote the same edition, across the ISBN-10 and
 * ISBN-13 forms. Used for display-side dedupe and ISBN pinning.
 */
export const isbnEquivalent = (
	a: string | null | undefined,
	b: string | null | undefined,
): boolean => {
	if (!a || !b) return false;
	const ca = toIsbn13(a);
	return ca !== undefined && ca === toIsbn13(b);
};

/**
 * The ISBN-10 an ASIN stands for. Amazon uses the ISBN-10 as the ASIN of most
 * paper books; Kindle ASINs (`B0…`) and anything with a bad check digit are
 * not ISBNs and yield undefined.
 */
export const isbn10FromAsin = (raw: string): string | undefined => {
	const asin = raw.trim().toUpperCase();
	if (!/^\d{9}[\dX]$/.test(asin)) return undefined;

	let sum = 0;
	for (let i = 0; i < 10; i += 1) {
		const char = asin.charAt(i);
		sum += (char === "X" ? 10 : Number(char)) * (10 - i);
	}
	return sum % 11 === 0 ? asin : undefined;
};

const ASIN_LABELS = ["asin", "amazon", "mobi-asin"];

/**
 * The ISBN to look a book up by: its `isbn` identifier when valid, else an
 * ASIN that is really an ISBN-10 (paper books).
 */
export const lookupIsbn = (
	identifiers: readonly { label: string; value: string }[],
): string | null => {
	const labelled = (labels: readonly string[]) =>
		identifiers.filter((id) => labels.includes(id.label.toLowerCase()));

	for (const id of labelled(["isbn"])) {
		const isbn = normalizeIsbn(id.value);
		if (isbn) return isbn;
	}
	for (const id of labelled(ASIN_LABELS)) {
		const isbn = isbn10FromAsin(id.value);
		if (isbn) return isbn;
	}
	return null;
};
