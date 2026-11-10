import { useCallback, useState } from "react";
import { usePlatform } from "@/lib/platform/context";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { libraryCatalog } from "@/lib/services/library-catalog";
import { removeLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

export type RemoveLibraryStep =
	| { id: "idle" }
	| {
			id: "confirm";
			library: LibraryPath;
			busy: boolean;
			error: string | null;
	  }
	/** Shown only while the folder is still there to show. */
	| {
			id: "removed";
			library: LibraryPath;
			/** No library is left; the library window is back at first run. */
			wasLast: boolean;
	  };

export interface RemoveLibrary {
	step: RemoveLibraryStep;
	request: (library: LibraryPath) => void;
	confirm: () => void;
	cancel: () => void;
	showFolder: () => void;
	done: () => void;
}

/**
 * Where to go when the open library is removed: the next library in the
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

/**
 * "Remove…": confirm, switch away if the library is open (to
 * the nearest one that still opens), forget it, then offer its folder. When
 * it was the last library the library window returns to first run, and
 * Settings, a separate window, hides once the person is done here.
 */
export const useRemoveLibrary = (): RemoveLibrary => {
	const platform = usePlatform();
	const [step, setStep] = useState<RemoveLibraryStep>({ id: "idle" });

	const request = useCallback((library: LibraryPath) => {
		setStep({ id: "confirm", library, busy: false, error: null });
	}, []);

	const cancel = useCallback(() => {
		setStep((current) =>
			current.id === "confirm" && current.busy ? current : { id: "idle" },
		);
	}, []);

	const finish = useCallback(
		(wasLast: boolean) => {
			if (wasLast && !platform.window.isMain) void platform.window.hide();
			setStep({ id: "idle" });
		},
		[platform],
	);

	const confirm = useCallback(() => {
		if (step.id !== "confirm" || step.busy) return;
		const { library } = step;
		setStep({ ...step, busy: true, error: null });
		void (async () => {
			try {
				const { activeLibraryId, libraryPaths } = useSettings.getState();
				if (activeLibraryId === library.id) {
					for (const next of successorsOf(libraryPaths, library.id)) {
						if (await isValidLibrary(next.absolutePath)) {
							await setActiveLibrary(next.id);
							break;
						}
					}
				}
				await removeLibrary(library.id);
				const wasLast = useSettings.getState().activeLibraryId === "";
				const folderRemains =
					platform.capabilities.canRevealInFileManager &&
					(await isValidLibrary(library.absolutePath));
				if (folderRemains) {
					setStep({ id: "removed", library, wasLast });
				} else {
					finish(wasLast);
				}
			} catch (error) {
				setStep({
					id: "confirm",
					library,
					busy: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	}, [step, platform, finish]);

	const done = useCallback(() => {
		finish(step.id === "removed" && step.wasLast);
	}, [step, finish]);

	const showFolder = useCallback(() => {
		if (step.id !== "removed") return;
		void platform.fileOpener.revealInFileManager(step.library.absolutePath);
		done();
	}, [step, platform, done]);

	return { step, request, confirm, cancel, showFolder, done };
};
