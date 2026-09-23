import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type {
	SwitchEvent,
	SwitchSnapshot,
	SwitchStage,
} from "@/lib/library-switch/machine";
import {
	CURTAIN_DEADLINE_MS,
	CURTAIN_IN_MS,
	CURTAIN_OUT_MS,
	initSwitch,
	msToPulseBoundary,
	transition,
} from "@/lib/library-switch/machine";
import { decideCurtainSwitch } from "@/lib/library-switch/policy";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

const SWITCH_FAILED_TOAST_ID = "library-switch-failed";
const SWITCH_FAILED_TITLE = "Couldn't switch libraries";
const SWITCH_FAILED_FALLBACK = "The library could not be opened.";

/**
 * A failed switch leaves settings pointing at the library that failed to
 * open while the old one stays on screen. Point it back, so the picker, a
 * retry click, and the next launch agree with what's visible. The store
 * reads the re-selection as a cancel, which is a no-op once the failure
 * has settled. Boot failures have no confirmed library and are left to the
 * first-run flow.
 */
const revertToConfirmedLibrary = (confirmedPath: string | null): void => {
	if (confirmedPath === null) return;
	const { libraryPaths, activeLibraryId } = useSettings.getState();
	const confirmed = libraryPaths.find(
		(library) => library.absolutePath === confirmedPath,
	);
	if (!confirmed || confirmed.id === activeLibraryId) return;
	setActiveLibrary(confirmed.id).catch((error: unknown) => {
		console.error("Failed to revert the active library:", error);
	});
};

export interface LibrarySwitchFlow {
	stage: SwitchStage;
}

/**
 * Imperative shell for the library-switch curtain: watches the settings and
 * library stores (in every window, since the switch chain runs in each), and
 * owns the deadline, fade-in, min-hold, progress-tick, and reveal timers.
 *
 * The library store loads a switch into a shadow generation while the old
 * content stays on screen, so SWITCH_STARTED is a deadline, not a given: the
 * shell starts a CURTAIN_DEADLINE_MS timer on a path change and only arms the
 * machine if no flip (a fresh confirmedLibraryPath) lands first — a fast
 * switch swaps in one frame with no curtain at all. A switch back to the
 * confirmed library is a cancel: any armed curtain lifts via READY.
 */
export const useLibrarySwitch = (): LibrarySwitchFlow => {
	const [snapshot, setSnapshot] = useState<SwitchSnapshot>(initSwitch);
	const snapshotRef = useRef(snapshot);
	/** Wall-clock start of the current curtain's switch; feeds the tick
	 * events (reset when the curtain actually arms, so the bar starts its
	 * first pulse from zero). */
	const startedAtRef = useRef(0);
	/** Bumped on every detected switch so timers scheduled for an earlier
	 * switch (deadline, delayed READY) can detect staleness. */
	const switchGenRef = useRef(0);
	/** Deadline timer arming the curtain if the shadow load is slow. */
	const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

	const clearDeadline = useCallback(() => {
		if (deadlineRef.current === null) return;
		clearTimeout(deadlineRef.current);
		deadlineRef.current = null;
	}, []);

	// Library-store observation: translate the store's flip/error milestones
	// into machine events. A flip is a fresh confirmedLibraryPath (or the
	// boot-time first ready) — the machine ignores READY outside
	// arming/working, so unengaged flips never curtain.
	useEffect(() => {
		type StoreState = ReturnType<typeof useLibraryStore.getState>;
		const check = (state: StoreState, prev?: StoreState) => {
			const flipped =
				state.libraryState === LibraryState.ready &&
				state.confirmedLibraryPath !== null &&
				(prev?.libraryState !== LibraryState.ready ||
					prev?.confirmedLibraryPath !== state.confirmedLibraryPath);
			if (flipped) {
				clearDeadline();
				const gen = switchGenRef.current;
				const engaged =
					snapshotRef.current.stage.id === "arming" ||
					snapshotRef.current.stage.id === "working";
				if (!engaged) return;
				// Hold READY until the bar's current pulse completes its sweep,
				// then let it snap to 100% and lift.
				const remaining = msToPulseBoundary(
					performance.now() - startedAtRef.current,
				);
				setTimeout(() => {
					if (switchGenRef.current === gen) send({ type: "READY" });
				}, remaining);
			}
			// Identity, not null→set: a second failure before any flip
			// replaces the error without ever clearing it.
			const failed =
				state.libraryError !== null &&
				state.libraryError !== prev?.libraryError;
			if (failed) {
				// A switch that fails inside the deadline must not arm the
				// curtain afterwards — no flip would ever come to lift it.
				clearDeadline();
				revertToConfirmedLibrary(state.confirmedLibraryPath);
				const engaged =
					snapshotRef.current.stage.id === "arming" ||
					snapshotRef.current.stage.id === "working";
				const message = state.libraryError?.message ?? SWITCH_FAILED_FALLBACK;
				// Toast when the failure is visible as a failed switch: curtain
				// up, or a shadow load that failed while ready content stayed
				// on screen. Boot failures surface through the first-run flow
				// instead.
				if (
					prev !== undefined &&
					(engaged || state.libraryState === LibraryState.ready)
				) {
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
	}, [send, clearDeadline]);

	// Switch detection: a path change away from an established ready library
	// (or mid-curtain, covering a fast re-switch) starts the shadow-load
	// deadline — or cancels when the target is the confirmed library.
	useEffect(() => {
		const currentPath = activeLibrary?.absolutePath ?? null;
		const prevPath = lastPathRef.current;
		const wasReady = lastReadyRef.current;
		lastPathRef.current = currentPath;
		lastReadyRef.current = libraryState === LibraryState.ready;

		if (prevPath === null || currentPath === null || prevPath === currentPath) {
			return;
		}
		if (!activeLibrary) return;

		const decision = decideCurtainSwitch({
			curtainUp: snapshotRef.current.stage.id !== "idle",
			wasReady,
			targetPath: currentPath,
			confirmedPath: useLibraryStore.getState().confirmedLibraryPath,
		});
		switch (decision.kind) {
			case "ignore":
				return;
			case "cancel":
				// The store drops its pending shadow; lift the curtain if it
				// armed (READY is inert while idle).
				clearDeadline();
				send({ type: "READY" });
				return;
			case "show-immediately":
				clearDeadline();
				startedAtRef.current = performance.now();
				switchGenRef.current += 1;
				send({ type: "SWITCH_STARTED", name: activeLibrary.displayName });
				return;
			case "arm-deadline": {
				clearDeadline();
				switchGenRef.current += 1;
				const gen = switchGenRef.current;
				deadlineRef.current = setTimeout(() => {
					deadlineRef.current = null;
					if (switchGenRef.current !== gen) return;
					// The curtain arms now; the bar starts its first pulse fresh.
					startedAtRef.current = performance.now();
					send({ type: "SWITCH_STARTED", name: activeLibrary.displayName });
				}, CURTAIN_DEADLINE_MS);
				return;
			}
		}
	}, [activeLibrary, libraryState, send, clearDeadline]);

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
