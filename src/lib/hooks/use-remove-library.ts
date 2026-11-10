import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui";
import {
	entryIds,
	type LeavingLibrary,
	withLeavingLibraries,
} from "@/lib/library-list/leaving-libraries";
import { usePlatform } from "@/lib/platform/context";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { libraryCatalog } from "@/lib/services/library-catalog";
import { removeLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

/** Lets the dialog finish closing before the row starts to wipe away. */
const DIALOG_CLOSE_MS = 150;
/** The row's wipe (LibraryListCard.module.css), plus slack. */
const WIPE_MS = 300;

export type RemoveLibraryStep =
	| { id: "idle" }
	| {
			id: "confirm";
			library: LibraryPath;
			/** Forgetting it sends the library window back to first run. */
			isLast: boolean;
	  };

export interface RemoveLibrary {
	step: RemoveLibraryStep;
	/** Forgotten libraries whose rows are still wiping away. */
	leaving: LeavingLibrary[];
	request: (library: LibraryPath) => void;
	confirm: () => void;
	cancel: () => void;
}

/**
 * Where to go when the open library is forgotten: the next library in the
 * list, then the ones before it, nearest first.
 */
export const successorsOf = (
	libraries: readonly LibraryPath[],
	id: string,
): LibraryPath[] => {
	const index = libraries.findIndex((library) => library.id === id);
	if (index === -1) return libraries.filter((library) => library.id !== id);
	return [
		...libraries.slice(index + 1),
		...libraries.slice(0, index).reverse(),
	];
};

const isValidLibrary = (path: string) =>
	libraryCatalog.isValid(path).catch(() => false);

/** Opens the nearest other library that still opens, if any. */
const switchAwayFrom = async (id: string) => {
	const { libraryPaths } = useSettings.getState();
	for (const next of successorsOf(libraryPaths, id)) {
		if (await isValidLibrary(next.absolutePath)) {
			await setActiveLibrary(next.id);
			return;
		}
	}
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Forget…": one confirmation that says the files will not be removed, then
 * Citadel forgets the library (switching away first if it is open) and its
 * row wipes away. Forgetting the last library sends the library window back
 * to first run, and Settings, a separate window, hides.
 */
export const useRemoveLibrary = (): RemoveLibrary => {
	const platform = usePlatform();
	const [step, setStep] = useState<RemoveLibraryStep>({ id: "idle" });
	const [leaving, setLeavingState] = useState<LeavingLibrary[]>([]);
	const leavingRef = useRef<LeavingLibrary[]>([]);
	const mounted = useRef(true);

	useEffect(
		() => () => {
			mounted.current = false;
		},
		[],
	);

	const setLeaving = useCallback(
		(update: (current: LeavingLibrary[]) => LeavingLibrary[]) => {
			leavingRef.current = update(leavingRef.current);
			if (mounted.current) setLeavingState(leavingRef.current);
		},
		[],
	);

	const request = useCallback((library: LibraryPath) => {
		const isLast = useSettings.getState().libraryPaths.length <= 1;
		setStep({ id: "confirm", library, isLast });
	}, []);

	const cancel = useCallback(() => setStep({ id: "idle" }), []);

	const confirm = useCallback(() => {
		if (step.id !== "confirm") return;
		const { library, isLast } = step;
		setStep({ id: "idle" });
		const id = library.id;
		void (async () => {
			try {
				await wait(DIALOG_CLOSE_MS);
				if (isLast) {
					await removeLibrary(id);
					if (!platform.window.isMain) void platform.window.hide();
					return;
				}
				const { activeLibraryId, libraryPaths } = useSettings.getState();
				// Held in place first, so the row wipes away rather than vanishing.
				setLeaving((current) => [
					...current,
					{
						library,
						before: entryIds(withLeavingLibraries(libraryPaths, current)),
					},
				]);
				if (activeLibraryId === id) await switchAwayFrom(id);
				await removeLibrary(id);
				await wait(WIPE_MS);
			} catch (error) {
				toast.show({
					title: `Couldn’t forget “${library.displayName}”`,
					message: error instanceof Error ? error.message : String(error),
				});
			} finally {
				setLeaving((current) =>
					current.filter((entry) => entry.library.id !== id),
				);
			}
		})();
	}, [step, platform, setLeaving]);

	return { step, leaving, request, confirm, cancel };
};
