import { useRef, useState } from "react";
import { toast } from "@/components/ui";
import { none, type Option, some } from "@/lib/option";
import type { SmartShelf } from "@/lib/platform/settings/types";
import { useLibraryView } from "@/stores/library-view/store";
import { deleteSmartShelf, renameSmartShelf } from "@/stores/settings/actions";

/**
 * Deletes a shelf; the books it showed stay in the library. If the shelf
 * was showing, the window goes back to All Books rather than keep its name.
 */
export const deleteShelf = async (shelf: SmartShelf): Promise<void> => {
	try {
		await deleteSmartShelf(shelf.id);
	} catch (error) {
		toast.show({
			title: `Couldn’t delete “${shelf.name}”`,
			message: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	const view = useLibraryView.getState();
	if (view.activeShelfId === shelf.id) view.resetToAllBooks();
};

export interface ShelfRename {
	shelfId: string;
	draft: string;
	error: string | null;
}

export interface ShelfRenameActions {
	editing: Option<ShelfRename>;
	startRename: (shelf: SmartShelf) => void;
	editRename: (draft: string) => void;
	/** Enter and blur both commit, Finder style; Escape cancels. */
	commitRename: () => Promise<void>;
	cancelRename: () => void;
}

/** Inline rename of a sidebar shelf, from its right-click menu or F2. */
export const useShelfRename = (): ShelfRenameActions => {
	const [editing, setEditing] = useState<Option<ShelfRename>>(none());
	// Read by commitRename: the blur that follows Enter or Escape must see
	// the rename already finished, not the one its render captured.
	const current = useRef<Option<ShelfRename>>(none());
	const saving = useRef(false);
	const update = (next: Option<ShelfRename>) => {
		current.current = next;
		setEditing(next);
	};

	const commitRename = async () => {
		const open = current.current;
		if (!open.isSome || saving.current) return;
		saving.current = true;
		try {
			await renameSmartShelf(open.value.shelfId, open.value.draft);
			update(none());
		} catch (error) {
			const latest = current.current;
			if (latest.isSome && latest.value.shelfId === open.value.shelfId) {
				update(
					some({
						...latest.value,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		} finally {
			saving.current = false;
		}
	};

	return {
		editing,
		startRename: (shelf) =>
			update(some({ shelfId: shelf.id, draft: shelf.name, error: null })),
		editRename: (draft) => {
			const open = current.current;
			if (open.isSome) update(some({ ...open.value, draft, error: null }));
		},
		commitRename,
		cancelRename: () => update(none()),
	};
};

export interface ShelfDelete {
	/** The shelf Delete… is asking about. */
	confirming: Option<SmartShelf>;
	requestDelete: (shelf: SmartShelf) => void;
	confirmDelete: () => void;
	cancelDelete: () => void;
}

/** Delete…, which asks once (ADR 0014: rare and deliberate). */
export const useShelfDelete = (): ShelfDelete => {
	const [confirming, setConfirming] = useState<Option<SmartShelf>>(none());
	return {
		confirming,
		requestDelete: (shelf) => setConfirming(some(shelf)),
		confirmDelete: () => {
			if (!confirming.isSome) return;
			setConfirming(none());
			void deleteShelf(confirming.value);
		},
		cancelDelete: () => setConfirming(none()),
	};
};
