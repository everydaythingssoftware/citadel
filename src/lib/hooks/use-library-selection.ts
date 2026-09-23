import { useCallback } from "react";
import { commands } from "@/bindings";
import { toast } from "@/components/ui";
import { ADOPT_INVALID_ERROR } from "@/lib/first-run/machine";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { createLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

const INVALID_LIBRARY_TOAST_ID = "library-switch-invalid";

export type AdoptLibraryResult = { ok: true } | { ok: false; message: string };

export interface LibrarySelection {
	libraries: LibraryPath[];
	/**
	 * The library on screen. While the store is ready this follows the
	 * confirmed library — the one the visible generation belongs to — not
	 * settings' activeLibraryId, which moves the moment a switch is
	 * requested. Before the first confirmed open, falls back to settings.
	 */
	activeLibrary: LibraryPath | undefined;
	/** Validates the library, then switches; failures toast instead. */
	switchTo: (id: string) => Promise<void>;
	/** Validates a folder, adds it as a library, and switches to it. */
	adoptLibrary: (absolutePath: string) => Promise<AdoptLibraryResult>;
}

export const useLibrarySelection = (): LibrarySelection => {
	const libraries = useSettings((state) => state.libraryPaths);
	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const libraryState = useLibraryStore((state) => state.libraryState);
	const confirmedLibraryPath = useLibraryStore(
		(state) => state.confirmedLibraryPath,
	);

	const confirmedLibrary =
		libraryState === LibraryState.ready && confirmedLibraryPath !== null
			? libraries.find(
					(library) => library.absolutePath === confirmedLibraryPath,
				)
			: undefined;
	const displayedActiveId = confirmedLibrary?.id ?? activeLibraryId;
	const activeLibrary = libraries.find(
		(library) => library.id === displayedActiveId,
	);

	const switchTo = useCallback(
		async (id: string) => {
			if (id === activeLibraryId) return;
			const library = libraries.find((entry) => entry.id === id);
			if (!library) return;
			try {
				const valid = await commands.clbQueryIsPathValidLibrary(
					library.absolutePath,
				);
				if (!valid) {
					toast.show({
						id: INVALID_LIBRARY_TOAST_ID,
						title: "Not a Calibre library",
						message: ADOPT_INVALID_ERROR,
					});
					return;
				}
				await setActiveLibrary(id);
			} catch (error) {
				console.error("Library switch failed:", error);
				toast.show({
					id: INVALID_LIBRARY_TOAST_ID,
					title: "Couldn't switch libraries",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[activeLibraryId, libraries],
	);

	const adoptLibrary = useCallback(
		async (absolutePath: string): Promise<AdoptLibraryResult> => {
			const valid = await commands.clbQueryIsPathValidLibrary(absolutePath);
			if (!valid) return { ok: false, message: ADOPT_INVALID_ERROR };
			const newLibraryId = await createLibrary(absolutePath);
			await setActiveLibrary(newLibraryId);
			return { ok: true };
		},
		[],
	);

	return { libraries, activeLibrary, switchTo, adoptLibrary };
};
