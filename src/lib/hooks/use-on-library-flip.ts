import { useLayoutEffect, useRef } from "react";
import { useConfirmedLibraryPath } from "@/stores/library/store";

/**
 * Runs `onFlip` when the visible library changes to a different one. Keyed
 * on confirmedLibraryPath, the flip's identity field: the generation also
 * bumps on same-library invalidations (mutations), which must not count.
 * Skips boot, where the first library lands. A layout effect, so callers
 * adjust the view in the flip's own commit, before its first paint.
 */
export const useOnLibraryFlip = (onFlip: () => void): void => {
	const confirmedLibraryPath = useConfirmedLibraryPath();
	const previousPathRef = useRef<string | null>(null);

	useLayoutEffect(() => {
		const previous = previousPathRef.current;
		previousPathRef.current = confirmedLibraryPath;
		if (
			confirmedLibraryPath === null ||
			previous === null ||
			previous === confirmedLibraryPath
		) {
			return;
		}
		onFlip();
	}, [confirmedLibraryPath, onFlip]);
};
