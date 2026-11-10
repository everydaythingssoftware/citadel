import type { LibraryPath } from "@/lib/platform/settings/types";

/**
 * A library just forgotten, kept in the list at its old place for the moment
 * its row takes to wipe away.
 */
export interface LeavingLibrary {
	library: LibraryPath;
	/** The IDs of the rows shown just before it left, to find its place. */
	before: readonly string[];
}

export type LibraryListEntry =
	| { kind: "library"; library: LibraryPath }
	| { kind: "leaving"; library: LibraryPath };

/** The rows' library IDs, in order. */
export const entryIds = (entries: readonly LibraryListEntry[]) =>
	entries.map((entry) => entry.library.id);

/**
 * The libraries with each leaving one back where it was: after its nearest
 * earlier neighbour still shown, else before its nearest later one. Leaving
 * libraries are placed in the order they left, so several leaving at once
 * (adjacent or not, from either end) keep the original order. A library
 * that is still in `libraries` shows as itself.
 */
export const withLeavingLibraries = (
	libraries: readonly LibraryPath[],
	leaving: readonly LeavingLibrary[],
): LibraryListEntry[] => {
	const entries: LibraryListEntry[] = libraries.map((library) => ({
		kind: "library",
		library,
	}));
	for (const { library, before } of leaving) {
		if (entries.some((entry) => entry.library.id === library.id)) continue;
		const shown = (id: string) =>
			entries.findIndex((entry) => entry.library.id === id);
		const at = before.indexOf(library.id);
		const earlier = before.slice(0, Math.max(at, 0)).reverse();
		const later = at === -1 ? [] : before.slice(at + 1);
		const predecessor = earlier.map(shown).find((index) => index !== -1);
		const successor = later.map(shown).find((index) => index !== -1);
		const position =
			predecessor !== undefined
				? predecessor + 1
				: (successor ?? entries.length);
		entries.splice(position, 0, { kind: "leaving", library });
	}
	return entries;
};
