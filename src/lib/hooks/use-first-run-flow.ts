import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "@/bindings";
import type {
	FlowEffect,
	FlowEvent,
	FlowMode,
	FlowSnapshot,
} from "@/lib/first-run/machine";
import {
	GRACE_MS,
	initFlow,
	transition,
	VALIDATE_SPINNER_DELAY_MS,
} from "@/lib/first-run/machine";
import { usePlatform } from "@/lib/platform/context";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { createLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";

/** Failed retry checks resolve no earlier than this, so the "Checking…"
 * spinner reads as a real check instead of a broken button. A successful
 * check proceeds immediately. */
const RETRY_MIN_DWELL_MS = 400;

const CREATE_ERROR_CODES = {
	"create-library/folder-not-empty": "folder-not-empty",
	"create-library/already-a-library": "already-a-library",
} as const;

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
			let detection: Awaited<
				ReturnType<typeof commands.clbQueryDetectCalibreLibrary>
			> = null;
			try {
				detection = await commands.clbQueryDetectCalibreLibrary();
			} catch (error) {
				console.error("Calibre library detection failed:", error);
			}
			send({ type: "DETECTED", detection });
			return;
		}

		case "load-default-path": {
			try {
				const result = await commands.clbQueryDefaultNewLibraryPath();
				if (result.status === "ok") {
					send({ type: "DEFAULT_PATH_LOADED", path: result.data });
					return;
				}
				console.error("Failed to resolve default library path:", result.error);
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
				valid = await commands.clbQueryIsPathValidLibrary(effect.path);
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
				const status = await commands.clbQueryPathSyncStatus(effect.path);
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
				const result = await commands.clbCmdCreateLibrary(effect.path);
				if (result.status === "ok") {
					send({ type: "CREATED" });
					return;
				}
				const code =
					CREATE_ERROR_CODES[result.error as keyof typeof CREATE_ERROR_CODES] ??
					"create-failed";
				send({ type: "CREATE_FAILED", code, message: result.error });
			} catch (error) {
				send({
					type: "CREATE_FAILED",
					code: "create-failed",
					message: error instanceof Error ? error.message : String(error),
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
				ok = await commands.clbQueryIsPathValidLibrary(effect.path);
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
	| { kind: "first-run" }
	| { kind: "broken-path"; path: string };

/**
 * One-shot boot decision (BUILD-SPEC step 1), latched at mount so mid-session
 * settings changes never re-trigger it: no active library → first-run flow;
 * an active library that fails validation → broken-path flow; otherwise the
 * normal app. Callers must not mount this before settings hydration.
 */
export const useBootDecision = (): BootDecision => {
	const [decision, setDecision] = useState<BootDecision>({ kind: "checking" });

	useEffect(() => {
		let alive = true;
		const active = useSettings.getState().getActiveLibrary();
		if (!active.isSome) {
			setDecision({ kind: "first-run" });
			return;
		}
		const path = active.value.absolutePath;
		void commands
			.clbQueryIsPathValidLibrary(path)
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

	return decision;
};
