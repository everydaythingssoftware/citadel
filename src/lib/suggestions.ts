/** Fewer typed characters than this show no suggestions: one letter matches nearly everything. */
export const MIN_QUERY_LENGTH = 2;

const rank = (candidate: string, needle: string): number | undefined => {
	const text = candidate.toLowerCase();
	if (text === needle) return 0;
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
 * are left out.
 */
export const rankSuggestions = (
	suggestions: string[],
	chosen: string[],
	query: string,
): string[] => {
	const needle = query.trim().toLowerCase();
	if (needle.length < MIN_QUERY_LENGTH) return [];
	const taken = new Set(chosen.map((value) => value.toLowerCase()));
	return suggestions
		.flatMap((candidate) => {
			if (taken.has(candidate.toLowerCase())) return [];
			const score = rank(candidate, needle);
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

/** The suggestion to pre-select: only one that is exactly what was typed. */
export const exactMatchIndex = (ranked: string[], query: string): number => {
	const needle = query.trim().toLowerCase();
	return ranked.findIndex((candidate) => candidate.toLowerCase() === needle);
};
