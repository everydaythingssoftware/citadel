import type { LibraryPath } from "@/lib/platform/settings/types";

/**
 * A library just removed from Citadel, still shown in the list as a short
 * "Removed … · Undo" row until its undo window closes.
 */
export interface PendingRemoval {
	library: LibraryPath;
	/**
	 * The IDs of the rows shown just before this removal, placeholders
	 * included, to find its place among them later.
	 */
	before: readonly string[];
	wasActive: boolean;
	/**
	 * placeholder: showing Undo; restoring: Undo in flight; closing: the
	 * placeholder is wiping away and will be dropped.
	 */
	phase: "placeholder" | "restoring" | "closing";
	error: string | null;
}

/** Removing the last library can't be undone in place, so it asks first. */
export const removalNeedsConfirmation = (libraryCount: number) =>
	libraryCount <= 1;

export type LibraryListEntry =
	| { kind: "library"; library: LibraryPath }
	| { kind: "removed"; removal: PendingRemoval };

const entryId = (entry: LibraryListEntry) =>
	entry.kind === "library" ? entry.library.id : entry.removal.library.id;

/** The rows' library IDs, in order. */
export const entryIds = (entries: readonly LibraryListEntry[]) =>
	entries.map(entryId);

/**
 * The libraries with each pending removal back where it was: after its
 * nearest earlier neighbour that is still shown, else before its nearest
 * later one. Removals are placed in the order they happened, so removing
 * several (adjacent or not, from either end) keeps the original order.
 * A library that is back in `libraries` (restored) shows as itself.
 */
export const withPendingRemovals = (
	libraries: readonly LibraryPath[],
	pending: readonly PendingRemoval[],
): LibraryListEntry[] => {
	const entries: LibraryListEntry[] = libraries.map((library) => ({
		kind: "library",
		library,
	}));
	for (const removal of pending) {
		const id = removal.library.id;
		if (entries.some((entry) => entryId(entry) === id)) continue;
		const shown = (otherId: string) =>
			entries.findIndex((entry) => entryId(entry) === otherId);
		const at = removal.before.indexOf(id);
		const earlier = removal.before.slice(0, Math.max(at, 0)).reverse();
		const later = at === -1 ? [] : removal.before.slice(at + 1);
		const predecessor = earlier.map(shown).find((index) => index !== -1);
		const successor = later.map(shown).find((index) => index !== -1);
		const position =
			predecessor !== undefined
				? predecessor + 1
				: successor !== undefined
					? successor
					: entries.length;
		entries.splice(position, 0, { kind: "removed", removal });
	}
	return entries;
};
