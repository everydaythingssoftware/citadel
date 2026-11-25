import type { SearchScope } from "@/bindings";

/** The fields that a bare word searches, with the values of the backend. */
export const SEARCH_SCOPE = {
	titlesAuthorsSeries: "titlesAuthorsSeries",
	allFields: "allFields",
} as const satisfies { [TScope in SearchScope]: TScope };

const SEARCH_SCOPES: readonly unknown[] = Object.values(SEARCH_SCOPE);

/** True when `value` is a known search scope, for example a stored value. */
export const isSearchScope = (value: unknown): value is SearchScope =>
	SEARCH_SCOPES.includes(value);

/** The name of each scope, as the scope menu shows it. */
export const SEARCH_SCOPE_LABELS: Record<SearchScope, string> = {
	titlesAuthorsSeries: "Titles, Authors & Series",
	allFields: "All Fields",
};
