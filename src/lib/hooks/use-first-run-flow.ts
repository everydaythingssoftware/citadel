import { useCallback, useEffect, useRef, useState } from "react";
import type {
	FlowEffect,
	FlowEvent,
	FlowMode,
	FlowSnapshot,
} from "@/lib/first-run/machine";
import {
	createErrorCodeFor,
	GRACE_MS,
	initFlow,
	transition,
	VALIDATE_SPINNER_DELAY_MS,
} from "@/lib/first-run/machine";
import { usePlatform } from "@/lib/platform/context";
import { libraryCatalog } from "@/lib/services/library-catalog";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { createLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

/** Failed retry checks resolve no earlier than this, so the "Checking…"
 * spinner reads as a real check instead of a broken button. A successful
 * check proceeds immediately. */
const RETRY_MIN_DWELL_MS = 400;

export interface FirstRunFlow {
	snapshot: FlowSnapshot;
	send: (event: FlowEvent) => void;
}

/**
 * Imperative shell for the first-run flow: owns the machine snapshot and runs
 * its effects (detection, native pickers, validation, sync checks, library
 * creation, the settings commit) plus the state-derived timers and the
 * library-store observation that feeds the opening stages.
 */
export const useFirstRunFlow = (mode: FlowMode): FirstRunFlow => {
	const platform = usePlatform();
	const platformRef = useRef(platform);
	platformRef.current = platform;

	const [init] = useState(() => initFlow(mode));
	const [snapshot, setSnapshot] = useState<FlowSnapshot>(init.snapshot);
	const snapshotRef = useRef(snapshot);
	/** Drops validation results that resolve after the user backed out and
	 * re-picked (only the latest in-flight validation may dispatch). */
	const validateToken = useRef(0);

	const sendRef = useRef<(event: FlowEvent) => void>(() => {});
	const send = useCallback((event: FlowEvent) => {
		const { snapshot: next, effects } = transition(snapshotRef.current, event);
		snapshotRef.current = next;
		setSnapshot(next);
		for (const effect of effects) {
			void runEffect(effect, sendRef.current, platformRef, validateToken);
		}
	}, []);
	sendRef.current = send;

	// Boot effects (detection for first-run mode), once on mount.
	const bootedRef = useRef(false);
	useEffect(() => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		for (const effect of init.effects) {
			void runEffect(effect, sendRef.current, platformRef, validateToken);
		}
	}, [init]);

	// Grace window: the commit spinner holds up to GRACE_MS before the staged
	// list mounts; an open that finishes inside it goes straight to the reveal.
	const inGrace =
		snapshot.step.id === "opening" && snapshot.step.phase === "grace";
	useEffect(() => {
		if (!inGrace) return;
		const timer = setTimeout(() => send({ type: "GRACE_ELAPSED" }), GRACE_MS);
		return () => clearTimeout(timer);
	}, [inGrace, send]);

	// Validation show-delay: the "Checking folder…" view only mounts if the
	// (normally instant) validation is still unresolved after the delay.
	const awaitingValidation =
		snapshot.step.id === "validating" && !snapshot.step.slow;
	useEffect(() => {
		if (!awaitingValidation) return;
		const timer = setTimeout(
			() => send({ type: "VALIDATION_SLOW" }),
			VALIDATE_SPINNER_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [awaitingValidation, send]);

	// Library-store observation: while an open is committed and in flight,
	// translate the store's real milestones into stage events.
	const observing =
		snapshot.committed &&
		(snapshot.step.id === "opening" ||
			(snapshot.step.id === "create" && snapshot.step.busy));
	useEffect(() => {
		if (!observing) return;
		type StoreState = ReturnType<typeof useLibraryStore.getState>;
		const check = (state: StoreState, prev?: StoreState) => {
			if (state.library !== null && (prev?.library ?? null) === null) {
				send({ type: "OPEN_CONNECTED" });
			}
			const readyNow = state.libraryState === LibraryState.ready;
			const readyBefore = prev?.libraryState === LibraryState.ready;
			if (readyNow && !readyBefore) {
				send({ type: "OPEN_METADATA_LOADED" });
			}
			const openedNow = readyNow && state.coversSeeded;
			const openedBefore = readyBefore && (prev?.coversSeeded ?? false);
			if (openedNow && !openedBefore) {
				send({
					type: "OPEN_READY",
					books: state.libraryTotal ?? 0,
					authors: state.authors.length,
				});
			}
			if (
				state.libraryState === LibraryState.error &&
				prev?.libraryState !== LibraryState.error
			) {
				send({ type: "OPEN_FAILED" });
			}
		};
		// Catch milestones that landed before this subscription was set up.
		check(useLibraryStore.getState());
		return useLibraryStore.subscribe(check);
	}, [observing, send]);

	return { snapshot, send };
};

const runEffect = async (
	effect: FlowEffect,
	send: (event: FlowEvent) => void,
	platformRef: React.RefObject<ReturnType<typeof usePlatform>>,
	validateToken: React.RefObject<number>,
): Promise<void> => {
	switch (effect.kind) {
		case "detect": {
			let detection: Awaited<ReturnType<typeof libraryCatalog.detect>> = null;
			try {
				detection = await libraryCatalog.detect();
			} catch (error) {
				console.error("Calibre library detection failed:", error);
			}
			send({ type: "DETECTED", detection });
			return;
		}

		case "load-default-path": {
			try {
				const path = await libraryCatalog.defaultNewPath();
				send({ type: "DEFAULT_PATH_LOADED", path });
			} catch (error) {
				console.error("Failed to resolve default library path:", error);
			}
			return;
		}

		case "open-adopt-picker": {
			const path = await platformRef.current.dialogs.openDirectory({
				title: "Select Calibre Library Folder",
			});
			send(
				path === null
					? { type: "ADOPT_PICK_CANCELLED" }
					: { type: "ADOPT_PICKED", path },
			);
			return;
		}

		case "open-create-target-picker": {
			const path = await platformRef.current.dialogs.openDirectory({
				title: "Choose a Folder for Your New Library",
			});
			send(
				path === null
					? { type: "CREATE_TARGET_CANCELLED" }
					: { type: "CREATE_TARGET_PICKED", path },
			);
			return;
		}

		case "validate": {
			validateToken.current += 1;
			const token = validateToken.current;
			let valid = false;
			try {
				valid = await libraryCatalog.isValid(effect.path);
			} catch (error) {
				console.error("Library validation failed:", error);
			}
			if (token === validateToken.current) {
				send({ type: "VALIDATED", valid });
			}
			return;
		}

		case "check-sync": {
			try {
				const status = await libraryCatalog.syncStatus(effect.path);
				send({
					type: "SYNC_RESULT",
					synced: status.synced,
					provider: status.provider,
				});
			} catch (error) {
				// The sync check is a best-effort warning input; failing open is
				// the contract (absence of a warning never promises safety).
				console.error("Sync-status check failed:", error);
				send({ type: "SYNC_RESULT", synced: false, provider: null });
			}
			return;
		}

		case "create-library": {
			try {
				await libraryCatalog.create(effect.path);
				send({ type: "CREATED" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				send({
					type: "CREATE_FAILED",
					code: createErrorCodeFor(message),
					message,
				});
			}
			return;
		}

		case "commit-library": {
			try {
				const previousActive = useSettings.getState().activeLibraryId;
				const id = await createLibrary(effect.path);
				await setActiveLibrary(id);
				// Re-adopting the already-active library doesn't change settings,
				// so the initializer hook won't re-run; restart a failed open
				// explicitly.
				if (
					previousActive === id &&
					useLibraryStore.getState().libraryState === LibraryState.error
				) {
					void useLibraryStore.getState().actions.initialize(effect.path);
				}
			} catch (error) {
				console.error("Failed to commit library to settings:", error);
				send({ type: "OPEN_FAILED" });
			}
			return;
		}

		case "reopen-library": {
			const store = useLibraryStore.getState();
			// After a boot-time broken path the app hasn't mounted yet: mounting
			// (gated on `committed`) runs the initializer. Only a failed earlier
			// open needs an explicit restart.
			if (store.libraryState === LibraryState.error) {
				void store.actions.initialize(effect.path);
			}
			return;
		}

		case "revalidate": {
			const started = Date.now();
			let ok = false;
			try {
				ok = await libraryCatalog.isValid(effect.path);
			} catch (error) {
				console.error("Library revalidation failed:", error);
			}
			if (!ok) {
				const dwell = RETRY_MIN_DWELL_MS - (Date.now() - started);
				if (dwell > 0) {
					await new Promise((resolve) => setTimeout(resolve, dwell));
				}
			}
			send({ type: "RETRY_RESULT", ok });
			return;
		}
	}
};

export type BootDecision =
	| { kind: "checking" }
	| { kind: "normal" }
	/** `run` counts restarts, so each one mounts a fresh flow. */
	| { kind: "first-run"; run: number }
	| { kind: "broken-path"; path: string };

/**
 * Boot decision (BUILD-SPEC step 1), latched at mount: no active library →
 * first-run flow; an active library that fails validation → broken-path
 * flow; otherwise the normal app. The one mid-session change that re-decides
 * is the active library being cleared (the last one was removed), which
 * restarts first run. Callers must not mount this before settings hydration.
 */
export const useBootDecision = (): BootDecision => {
	const [decision, setDecision] = useState<BootDecision>({ kind: "checking" });

	useEffect(() => {
		let alive = true;
		const active = useSettings.getState().getActiveLibrary();
		if (!active.isSome) {
			setDecision({ kind: "first-run", run: 0 });
			return;
		}
		const path = active.value.absolutePath;
		void libraryCatalog
			.isValid(path)
			.catch((error: unknown) => {
				console.error("Boot library validation failed:", error);
				return false;
			})
			.then((valid) => {
				if (!alive) return;
				setDecision(valid ? { kind: "normal" } : { kind: "broken-path", path });
			});
		return () => {
			alive = false;
		};
	}, []);

	// Removing the last library clears the active one mid-session: first run
	// comes back in the library window, so a library can be found or created
	// again. The Settings window hides itself instead.
	const isMainWindow = usePlatform().window.isMain;
	useEffect(
		() =>
			useSettings.subscribe((state, previous) => {
				if (!isMainWindow) return;
				if (previous.activeLibraryId && !state.activeLibraryId) {
					setDecision((current) => ({
						kind: "first-run",
						run: current.kind === "first-run" ? current.run + 1 : 1,
					}));
				}
			}),
		[isMainWindow],
	);

	return decision;
};
