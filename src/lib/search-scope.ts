import type { SearchScope } from "@/bindings";

/** The fields that a bare word searches, with the values of the backend. */
export const SEARCH_SCOPE = {
	titlesAuthorsSeries: "titlesAuthorsSeries",
	allFields: "allFields",
} as const satisfies { [TScope in SearchScope]: TScope };
