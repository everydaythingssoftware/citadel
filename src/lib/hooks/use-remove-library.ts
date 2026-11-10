import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui";
import {
	entryIds,
	type PendingRemoval,
	removalNeedsConfirmation,
	withPendingRemovals,
} from "@/lib/library-list/pending-removals";
import { usePlatform } from "@/lib/platform/context";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { libraryCatalog } from "@/lib/services/library-catalog";
import {
	removeLibrary,
	restoreLibrary,
	setActiveLibrary,
} from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

/** How long a removed library's row offers Undo. */
export const UNDO_WINDOW_MS = 8000;
/** The placeholder's closing wipe (LibraryListCard.module.css), plus slack. */
const CLOSE_MS = 300;

export type RemoveLibraryStep =
	| { id: "idle" }
	| {
			id: "confirm";
			library: LibraryPath;
			busy: boolean;
			error: string | null;
	  };

export interface RemoveLibrary {
	/** The confirmation, asked only before removing the last library. */
	step: RemoveLibraryStep;
	/** Removed libraries still showing their "Removed … · Undo" row. */
	pending: PendingRemoval[];
	remove: (library: LibraryPath) => void;
	undo: (id: string) => void;
	confirm: () => void;
	cancel: () => void;
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

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

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

/**
 * "Remove": the library is forgotten at once (switching away first if it
 * is open) and its row turns into "Removed … · Undo" for a few seconds, then
 * wipes away. Undo puts it back exactly, and reopens it if it was open.
 * Only the last library asks first: removing it sends the library window
 * back to first run, and Settings, a separate window, hides.
 */
export const useRemoveLibrary = (): RemoveLibrary => {
	const platform = usePlatform();
	const [step, setStep] = useState<RemoveLibraryStep>({ id: "idle" });
	const [pending, setPendingState] = useState<PendingRemoval[]>([]);
	const pendingRef = useRef<PendingRemoval[]>([]);
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	const setPending = useCallback(
		(update: (current: PendingRemoval[]) => PendingRemoval[]) => {
			pendingRef.current = update(pendingRef.current);
			setPendingState(pendingRef.current);
		},
		[],
	);

	const patch = useCallback(
		(id: string, changes: Partial<PendingRemoval>) =>
			setPending((current) =>
				current.map((removal) =>
					removal.library.id === id ? { ...removal, ...changes } : removal,
				),
			),
		[setPending],
	);

	const drop = useCallback(
		(id: string) =>
			setPending((current) =>
				current.filter((removal) => removal.library.id !== id),
			),
		[setPending],
	);

	const clearTimer = useCallback((id: string) => {
		const timer = timers.current.get(id);
		if (timer !== undefined) clearTimeout(timer);
		timers.current.delete(id);
	}, []);

	const scheduleClose = useCallback(
		(id: string) => {
			clearTimer(id);
			timers.current.set(
				id,
				setTimeout(() => {
					patch(id, { phase: "closing" });
					timers.current.set(
						id,
						setTimeout(() => {
							timers.current.delete(id);
							drop(id);
						}, CLOSE_MS),
					);
				}, UNDO_WINDOW_MS),
			);
		},
		[clearTimer, patch, drop],
	);

	useEffect(() => {
		const active = timers.current;
		return () => {
			for (const timer of active.values()) clearTimeout(timer);
			active.clear();
		};
	}, []);

	const remove = useCallback(
		(library: LibraryPath) => {
			const { activeLibraryId, libraryPaths } = useSettings.getState();
			if (pendingRef.current.some((p) => p.library.id === library.id)) return;
			if (removalNeedsConfirmation(libraryPaths.length)) {
				setStep({ id: "confirm", library, busy: false, error: null });
				return;
			}
			const wasActive = activeLibraryId === library.id;
			// The placeholder goes in first, so the row turns into it the moment
			// the library leaves the list, without a frame of either missing.
			setPending((current) => [
				...current,
				{
					library,
					before: entryIds(withPendingRemovals(libraryPaths, current)),
					wasActive,
					phase: "placeholder",
					error: null,
				},
			]);
			void (async () => {
				try {
					if (wasActive) await switchAwayFrom(library.id);
					await removeLibrary(library.id);
					scheduleClose(library.id);
				} catch (error) {
					drop(library.id);
					toast.show({
						title: `Couldn’t remove “${library.displayName}”`,
						message: messageOf(error),
					});
				}
			})();
		},
		[setPending, scheduleClose, drop],
	);

	const undo = useCallback(
		(id: string) => {
			const removal = pendingRef.current.find((p) => p.library.id === id);
			if (removal?.phase !== "placeholder") return;
			clearTimer(id);
			patch(id, { phase: "restoring", error: null });
			void (async () => {
				try {
					await restoreLibrary(id);
					if (removal.wasActive) await setActiveLibrary(id);
					drop(id);
				} catch (error) {
					patch(id, { phase: "placeholder", error: messageOf(error) });
					scheduleClose(id);
				}
			})();
		},
		[clearTimer, patch, drop, scheduleClose],
	);

	const cancel = useCallback(() => {
		setStep((current) =>
			current.id === "confirm" && current.busy ? current : { id: "idle" },
		);
	}, []);

	const confirm = useCallback(() => {
		if (step.id !== "confirm" || step.busy) return;
		const { library } = step;
		setStep({ ...step, busy: true, error: null });
		void (async () => {
			try {
				await removeLibrary(library.id);
				if (!platform.window.isMain) void platform.window.hide();
				setStep({ id: "idle" });
			} catch (error) {
				setStep({
					id: "confirm",
					library,
					busy: false,
					error: messageOf(error),
				});
			}
		})();
	}, [step, platform]);

	return { step, pending, remove, undo, confirm, cancel };
};
