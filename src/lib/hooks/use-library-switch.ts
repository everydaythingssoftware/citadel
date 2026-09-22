import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type {
	SwitchEvent,
	SwitchSnapshot,
	SwitchStage,
} from "@/lib/library-switch/machine";
import {
	CURTAIN_IN_MS,
	CURTAIN_OUT_MS,
	initSwitch,
	msToPulseBoundary,
	transition,
} from "@/lib/library-switch/machine";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { useSettings } from "@/stores/settings/store";

const SWITCH_FAILED_TOAST_ID = "library-switch-failed";
const SWITCH_FAILED_TITLE = "Couldn't switch libraries";
const SWITCH_FAILED_FALLBACK = "The library could not be opened.";

export interface LibrarySwitchFlow {
	stage: SwitchStage;
}

/**
 * Imperative shell for the library-switch curtain: watches the settings and
 * library stores (in every window, since the switch chain runs in each), arms
 * the machine only when the active path departs from an established ready
 * library, and owns the fade-in, min-hold, progress-tick, and reveal timers. On a failed
 * open it toasts the error; the machine itself never performs effects.
 */
export const useLibrarySwitch = (): LibrarySwitchFlow => {
	const [snapshot, setSnapshot] = useState<SwitchSnapshot>(initSwitch);
	const snapshotRef = useRef(snapshot);
	/** Wall-clock start of the current switch; feeds the tick events. */
	const startedAtRef = useRef(0);
	/** Bumped on every SWITCH_STARTED so timers scheduled for an earlier
	 * switch (e.g. a delayed READY) can detect staleness. */
	const switchGenRef = useRef(0);
	/** Last observed (activePath, storeReady) pair — the from-ready guard. */
	const lastPathRef = useRef<string | null>(null);
	const lastReadyRef = useRef(false);

	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const libraryPaths = useSettings((state) => state.libraryPaths);
	const libraryState = useLibraryStore((state) => state.libraryState);

	const activeLibrary = activeLibraryId
		? (libraryPaths.find((library) => library.id === activeLibraryId) ?? null)
		: null;

	const send = useCallback((event: SwitchEvent) => {
		const next = transition(snapshotRef.current, event);
		if (next === snapshotRef.current) return;
		snapshotRef.current = next;
		setSnapshot(next);
	}, []);

	// Library-store observation: translate the store's ready/error
	// milestones into machine events. The machine ignores them outside
	// arming/working, so boot-time and retry milestones never curtain.
	useEffect(() => {
		type StoreState = ReturnType<typeof useLibraryStore.getState>;
		const check = (state: StoreState, prev?: StoreState) => {
			if (
				state.libraryState === LibraryState.ready &&
				prev?.libraryState !== LibraryState.ready
			) {
				const gen = switchGenRef.current;
				const engaged =
					snapshotRef.current.stage.id === "arming" ||
					snapshotRef.current.stage.id === "working";
				if (!engaged) {
					send({ type: "READY" });
					return;
				}
				// Hold READY until the bar's current pulse completes its sweep,
				// then let it snap to 100% and lift.
				const remaining = msToPulseBoundary(
					performance.now() - startedAtRef.current,
				);
				setTimeout(() => {
					if (switchGenRef.current === gen) send({ type: "READY" });
				}, remaining);
			}
			if (
				state.libraryState === LibraryState.error &&
				prev?.libraryState !== LibraryState.error
			) {
				const engaged =
					snapshotRef.current.stage.id === "arming" ||
					snapshotRef.current.stage.id === "working";
				const message = state.libraryError?.message ?? SWITCH_FAILED_FALLBACK;
				if (engaged) {
					toast.show({
						id: SWITCH_FAILED_TOAST_ID,
						title: SWITCH_FAILED_TITLE,
						message,
					});
				}
				send({ type: "FAILED", message });
			}
		};
		// Catch milestones that landed before this subscription was set up.
		check(useLibraryStore.getState());
		return useLibraryStore.subscribe(check);
	}, [send]);

	// Switch detection: a path change away from an established ready library
	// (or mid-curtain, covering a fast re-switch) arms the machine.
	useEffect(() => {
		const currentPath = activeLibrary?.absolutePath ?? null;
		const prevPath = lastPathRef.current;
		const wasReady = lastReadyRef.current;
		lastPathRef.current = currentPath;
		lastReadyRef.current = libraryState === LibraryState.ready;

		if (prevPath === null || currentPath === null || prevPath === currentPath) {
			return;
		}
		const engaged =
			snapshotRef.current.stage.id === "arming" ||
			snapshotRef.current.stage.id === "working";
		if (!wasReady && !engaged) return;
		if (!activeLibrary) return;

		startedAtRef.current = performance.now();
		switchGenRef.current += 1;
		send({ type: "SWITCH_STARTED", name: activeLibrary.displayName });
	}, [activeLibrary, libraryState, send]);

	// Fade-in: the curtain commits to the working state once the fade
	// completes (the stylesheet animates opacity over CURTAIN_IN_MS).
	const inArming = snapshot.stage.id === "arming";
	useEffect(() => {
		if (!inArming) return;
		const timer = setTimeout(
			() => send({ type: "FADE_IN_ELAPSED" }),
			CURTAIN_IN_MS,
		);
		return () => clearTimeout(timer);
	}, [inArming, send]);

	// Pseudo-progress: ticks drive the eased bar while the curtain holds.
	const ticking =
		snapshot.stage.id === "arming" || snapshot.stage.id === "working";
	useEffect(() => {
		if (!ticking) return;
		let frame = 0;
		const loop = () => {
			send({
				type: "TICK",
				elapsedMs: performance.now() - startedAtRef.current,
			});
			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, [ticking, send]);

	// Reveal: the curtain fades out, then unmounts. Reduced motion skips the
	// fade (the stylesheet zeroes it) and lifts immediately.
	const revealing = snapshot.stage.id === "revealing";
	const reduced = usePrefersReducedMotion();
	useEffect(() => {
		if (!revealing) return;
		const timer = setTimeout(
			() => send({ type: "REVEAL_ELAPSED" }),
			reduced ? 0 : CURTAIN_OUT_MS,
		);
		return () => clearTimeout(timer);
	}, [revealing, reduced, send]);

	return { stage: snapshot.stage };
};
