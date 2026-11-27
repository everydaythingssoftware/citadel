/** Fewer typed characters than this show no suggestions: one letter matches nearly everything. */
const MIN_QUERY_LENGTH = 2;

const rank = (candidate: string, query: string): number | undefined => {
	if (asciiLowerCase(candidate) === asciiLowerCase(query)) return 0;
	const text = candidate.toLowerCase();
	const needle = query.toLowerCase();
	if (text.startsWith(needle)) return 1;
	const at = text.indexOf(needle);
	if (at < 0) return undefined;
	// A match at the start of a word ("science" in "Hard Science Fiction")
	// beats one in the middle of a word.
	return /[\s\-/(&,.]/.test(text[at - 1] ?? "") ? 2 : 3;
};

/**
 * Suggestions for what's been typed, best first: an exact match, then ones
 * starting with it, then ones with a word starting with it, then the rest
 * containing it; shorter before longer within each. Already chosen values
 * are left out. An exact match and a chosen value ignore only ASCII case, as
 * SQLite `NOCASE` does. The other matches ignore all case.
 */
export const rankSuggestions = (
	suggestions: string[],
	chosen: string[],
	query: string,
): string[] => {
	const trimmed = query.trim();
	if (trimmed.length < MIN_QUERY_LENGTH) return [];
	const taken = new Set(chosen.map(asciiLowerCase));
	return suggestions
		.flatMap((candidate) => {
			if (taken.has(asciiLowerCase(candidate))) return [];
			const score = rank(candidate, trimmed);
			return score === undefined ? [] : [{ candidate, score }];
		})
		.sort(
			(a, b) =>
				a.score - b.score ||
				a.candidate.length - b.candidate.length ||
				a.candidate.localeCompare(b.candidate),
		)
		.map(({ candidate }) => candidate);
};

/**
 * The suggestion to pre-select: only one that is exactly what was typed,
 * ignoring ASCII case.
 */
export const exactMatchIndex = (ranked: string[], query: string): number => {
	const needle = asciiLowerCase(query.trim());
	return ranked.findIndex((candidate) => asciiLowerCase(candidate) === needle);
};

/**
 * Gives the text with each letter A to Z in lowercase. The other letters do
 * not change. SQLite `NOCASE` and the server use the same fold.
 */
export const asciiLowerCase = (text: string): string =>
	text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * The token that equals the trimmed text, ignoring ASCII case. The result has
 * the spelling of the token, not the spelling of the text.
 */
export const matchingToken = (
	tokens: readonly string[],
	text: string,
): string | undefined => {
	const needle = asciiLowerCase(text.trim());
	if (!needle) return undefined;
	return tokens.find((token) => asciiLowerCase(token) === needle);
};
