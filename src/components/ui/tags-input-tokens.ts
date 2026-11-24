import { matchingToken } from "@/lib/suggestions";

/**
 * Gives the accessible name of the remove button of a token. Without
 * `removeLabel`, the name is "Remove" and the token.
 */
export const tokenRemoveLabel = (
	token: string,
	removeLabel: ((token: string) => string) | undefined,
): string => removeLabel?.(token) ?? `Remove ${token}`;

/** The text of a token: its name, and the detail that follows the name. */
export interface TokenText {
	name: string;
	/** Undefined when the token shows only its name. */
	detail: string | undefined;
}

/**
 * Gives the text of a token. An empty detail from `tokenDetail` shows no
 * detail.
 */
export const tokenText = (
	token: string,
	tokenDetail: ((token: string) => string | undefined) | undefined,
): TokenText => ({ name: token, detail: tokenDetail?.(token) || undefined });

/**
 * What a commit of the typed text does: nothing for blank text, a commit of
 * the existing token, or a new token.
 */
export type TokenCommit =
	| { kind: "none" }
	| { kind: "existing"; token: string }
	| { kind: "new"; token: string };

/**
 * Gives the commit of the typed text. A text that is already a token, ignoring
 * ASCII case, commits that token with its own spelling. Another text is a new
 * token, with the spelling of the suggestion that matches it, if one does.
 */
export const tokenCommit = (
	tokens: readonly string[],
	suggestions: readonly string[],
	raw: string,
): TokenCommit => {
	const text = raw.trim();
	if (!text) return { kind: "none" };
	const existing = matchingToken(tokens, text);
	if (existing !== undefined) return { kind: "existing", token: existing };
	return { kind: "new", token: matchingToken(suggestions, text) ?? text };
};
