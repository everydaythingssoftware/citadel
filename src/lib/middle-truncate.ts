const ELLIPSIS = "…";

const extensionLength = (characters: string[]): number => {
	const dot = characters.lastIndexOf(".");
	return dot > 0 && characters.length - dot <= 8 ? characters.length - dot : 0;
};

/**
 * Shortens text to at most `maxLength` characters by cutting from the
 * middle, so the start of a filename and its extension both stay visible:
 * "The Child & Tchaikovsky.epub" → "The Child & T…aikovsky.epub".
 */
export const middleTruncate = (text: string, maxLength: number): string => {
	const characters = Array.from(text);
	if (characters.length <= maxLength) return text;
	const budget = Math.max(0, Math.floor(maxLength) - 1);
	if (budget === 0) return ELLIPSIS;
	const tailLength = Math.min(
		budget,
		Math.max(Math.ceil(budget / 2), extensionLength(characters)),
	);
	const head = characters
		.slice(0, budget - tailLength)
		.join("")
		.trimEnd();
	const tail = characters
		.slice(characters.length - tailLength)
		.join("")
		.trimStart();
	return `${head}${ELLIPSIS}${tail}`;
};

/**
 * The longest middle truncation of `text` that `fits`, found by binary
 * search over its length; the full text when it fits as is.
 */
export const fitMiddleTruncated = (
	text: string,
	fits: (candidate: string) => boolean,
): string => {
	if (fits(text)) return text;
	let low = 1;
	let high = Array.from(text).length - 1;
	let best = middleTruncate(text, 1);
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = middleTruncate(text, middle);
		if (fits(candidate)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
};
