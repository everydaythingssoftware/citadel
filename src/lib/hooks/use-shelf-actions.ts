import { useCallback, useState } from "react";
import { toast } from "@/components/ui";
import type { SmartShelf } from "@/lib/platform/settings/types";
import { useLibraryView } from "@/stores/library-view/store";
import { deleteSmartShelf, renameSmartShelf } from "@/stores/settings/actions";

export type DeleteShelfStep =
	| { id: "idle" }
	| { id: "confirm"; shelf: SmartShelf };

export interface ShelfActionDependencies {
	remove: (id: string) => Promise<void>;
	activeShelfId: () => string | null;
	resetToAllBooks: () => void;
	report: (title: string, message: string) => void;
}

/**
 * Deletes a shelf; the books it showed stay in the library. If the shelf
 * was showing, the window goes back to All Books rather than keep its name.
 */
export const deleteShelf = async (
	shelf: SmartShelf,
	{ remove, activeShelfId, resetToAllBooks, report }: ShelfActionDependencies,
): Promise<boolean> => {
	try {
		await remove(shelf.id);
	} catch (error) {
		report(
			`Couldn’t delete “${shelf.name}”`,
			error instanceof Error ? error.message : String(error),
		);
		return false;
	}
	if (activeShelfId() === shelf.id) resetToAllBooks();
	return true;
};

const DEPENDENCIES: ShelfActionDependencies = {
	remove: deleteSmartShelf,
	activeShelfId: () => useLibraryView.getState().activeShelfId,
	resetToAllBooks: () => useLibraryView.getState().resetToAllBooks(),
	report: (title, message) => toast.show({ title, message }),
};

export interface ShelfRename {
	shelfId: string;
	draft: string;
	error: string | null;
}

export interface ShelfActions {
	rename: ShelfRename | null;
	startRename: (shelf: SmartShelf) => void;
	editRename: (draft: string) => void;
	/** Enter and blur both commit, Finder style. */
	commitRename: () => Promise<void>;
	cancelRename: () => void;
	deleteStep: DeleteShelfStep;
	requestDelete: (shelf: SmartShelf) => void;
	confirmDelete: () => void;
	cancelDelete: () => void;
}

/**
 * The sidebar's shelf actions, reached from each shelf's right-click menu:
 * inline rename, and Delete…, which asks once (ADR 0014: rare and
 * deliberate) and says the books stay.
 */
export const useShelfActions = (
	dependencies: ShelfActionDependencies = DEPENDENCIES,
): ShelfActions => {
	const [rename, setRename] = useState<ShelfRename | null>(null);
	const [deleteStep, setDeleteStep] = useState<DeleteShelfStep>({
		id: "idle",
	});

	const startRename = useCallback((shelf: SmartShelf) => {
		setRename({ shelfId: shelf.id, draft: shelf.name, error: null });
	}, []);

	const editRename = useCallback((draft: string) => {
		setRename((current) => current && { ...current, draft, error: null });
	}, []);

	const commitRename = useCallback(async () => {
		if (!rename) return;
		try {
			await renameSmartShelf(rename.shelfId, rename.draft);
			setRename(null);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setRename((current) =>
				current?.shelfId === rename.shelfId
					? { ...current, error: message }
					: current,
			);
		}
	}, [rename]);

	const cancelRename = useCallback(() => setRename(null), []);

	const requestDelete = useCallback((shelf: SmartShelf) => {
		setDeleteStep({ id: "confirm", shelf });
	}, []);

	const cancelDelete = useCallback(() => setDeleteStep({ id: "idle" }), []);

	const confirmDelete = useCallback(() => {
		if (deleteStep.id !== "confirm") return;
		const { shelf } = deleteStep;
		setDeleteStep({ id: "idle" });
		void deleteShelf(shelf, dependencies);
	}, [deleteStep, dependencies]);

	return {
		rename,
		startRename,
		editRename,
		commitRename,
		cancelRename,
		deleteStep,
		requestDelete,
		confirmDelete,
		cancelDelete,
	};
};
