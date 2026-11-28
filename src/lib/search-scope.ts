import type { SearchScope } from "@/bindings";
import type { ContextMenuEntry } from "@/lib/context-menu";

/** The fields that a bare word searches, with the values of the backend. */
export const SEARCH_SCOPE = {
	titlesAuthorsSeries: "titlesAuthorsSeries",
	allFields: "allFields",
} as const satisfies { [TScope in SearchScope]: TScope };

/** The scopes, in the sequence of the scope menu. */
const SEARCH_SCOPES: readonly SearchScope[] = Object.values(SEARCH_SCOPE);

/** True when `value` is a known search scope, for example a stored value. */
export const isSearchScope = (value: unknown): value is SearchScope =>
	(SEARCH_SCOPES as readonly unknown[]).includes(value);

/** The texts of one scope, with the id of its item in the scope menu. */
interface ScopeTexts {
	menuItemId: string;
	/** The name of the scope, as the scope menu shows it. */
	label: string;
	/** The placeholder of the search field. */
	placeholder: string;
	/** The text of the empty state when a search finds no book. */
	noMatches: string;
}

/**
 * The texts of each scope. A new scope cannot compile without its texts, so
 * that it never shows the texts of another scope.
 */
const SCOPE_TEXTS: Record<SearchScope, ScopeTexts> = {
	titlesAuthorsSeries: {
		menuItemId: "search-titles-authors-series",
		label: "Titles, Authors & Series",
		placeholder: "Search",
		noMatches:
			"Search looks at titles, authors and series. Check the spelling, or search all fields.",
	},
	allFields: {
		menuItemId: "search-all-fields",
		label: "All Fields",
		placeholder: "Search all fields",
		noMatches:
			"Search looks at titles, authors, series, tags, publishers and identifiers. Check the spelling, or try fewer words.",
	},
};

/** The name of a scope, as the scope menu shows it. */
export const searchScopeLabel = (scope: SearchScope): string =>
	SCOPE_TEXTS[scope].label;

/** The items of the scope menu of the search field. */
export const searchScopeMenuItems = (
	current: SearchScope,
	select: (scope: SearchScope) => void,
): ContextMenuEntry[] =>
	SEARCH_SCOPES.map((scope) => ({
		id: SCOPE_TEXTS[scope].menuItemId,
		label: SCOPE_TEXTS[scope].label,
		checked: scope === current,
		onSelect: () => select(scope),
	}));

/** The placeholder of the search field for the scope of a bare word. */
export const searchPlaceholder = (scope: SearchScope): string =>
	SCOPE_TEXTS[scope].placeholder;

/**
 * The text of the empty state when a search finds no book. It names the
 * fields of `DEFAULT_BARE_FIELDS` and `ALL_BARE_FIELDS` in
 * `crates/libcalibre/src/search/sql.rs`.
 */
export const noMatchesText = (scope: SearchScope): string =>
	SCOPE_TEXTS[scope].noMatches;
