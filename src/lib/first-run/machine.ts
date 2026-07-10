import type { DetectionSource } from "@/bindings";

/**
 * CDL-19 first-run flow — pure state machine (functional core).
 *
 * `transition(snapshot, event)` returns the next snapshot plus a list of
 * one-shot effects for the imperative shell (`use-first-run-flow.ts`) to run:
 * detection, validation, sync checks, library creation, and the settings
 * commit all happen at the edges. Timers (grace window, validation spinner
 * delay) and library-store observation are derived from the current step by
 * the shell, so the reducer stays total and synchronous.
 *
 * The visual contract is `ai-docs/design/cdl-19-first-run/
 * morphing-card-improved.html`; the capability contract is BEHAVIOR.md.
 */

/** Commit spinner grace window: if the library opens inside it, the staged
 * list never mounts and the card goes straight to the reveal. */
export const GRACE_MS = 400;
/** Validation is a local file read that normally resolves in a few ms; the
 * "Checking folder…" view only mounts if it hasn't resolved by now. */
export const VALIDATE_SPINNER_DELAY_MS = 150;
/** Below this book count the reveal renders its numbers settled — counting
 * to 3 would turn the moment into a gimmick. */
export const REVEAL_ANIMATE_MIN = 100;

export const ADOPT_INVALID_ERROR =
	"No metadata.db inside. If your library lives in a subfolder, choose that folder instead.";
export const CREATE_NONEMPTY_ERROR =
	"This folder already contains files. Pick an empty folder for a new library.";
export const CREATE_EXISTING_ERROR =
	"This folder is already a Calibre library.";

export interface Detection {
	path: string;
	source: DetectionSource;
}

/** Which root screen the user came from; Back and cancel return here. */
export type FlowRoot = "found" | "chooser" | "broken";

/** What committed the open — decides what the card shows during the grace
 * window (found's inline spinner, the frozen root, the create card, the
 * broken card's checking state, or the held cloud warning when it was the
 * screen that committed). */
export type CommitVia =
	| "found"
	| "picker"
	| "open-instead"
	| "retry"
	| "cloud-warn";

export type CreateErrorCode =
	| "folder-not-empty"
	| "already-a-library"
	| "create-failed";

export interface CreateError {
	code: CreateErrorCode;
	message: string;
}

/** Create-card fields carried through sync-check/cloud-warn so Cancel can
 * restore the exact screen that committed. */
export interface CreateReturn {
	root: FlowRoot;
	path: string;
	defaultPath: string | null;
	fromInvalid: string | null;
}

/** What a sync check (and an interposed cloud warning) is gating. */
export type CommitKind =
	| { kind: "adopt-found" }
	| { kind: "adopt-picked" }
	| { kind: "adopt-open-instead"; create: CreateReturn }
	| { kind: "create"; create: CreateReturn };

export type FlowStep =
	| { id: "detecting" }
	| { id: "found" }
	| { id: "chooser" }
	| { id: "picking"; root: FlowRoot }
	| { id: "validating"; root: FlowRoot; path: string; slow: boolean }
	| { id: "adopt-invalid"; root: FlowRoot; path: string }
	| {
			id: "create";
			root: FlowRoot;
			/** Target folder in the well; null until the default path loads. */
			path: string | null;
			/** Backend-suggested default (~/Citadel); drives the helper copy. */
			defaultPath: string | null;
			/** Set when entered via the invalid-pick crossover: Back returns there. */
			fromInvalid: string | null;
			error: CreateError | null;
			busy: boolean;
			/** The native change-target sheet is up. */
			picking: boolean;
	  }
	| { id: "sync-check"; root: FlowRoot; path: string; commit: CommitKind }
	| {
			id: "cloud-warn";
			root: FlowRoot;
			path: string;
			provider: string;
			commit: CommitKind;
	  }
	| {
			id: "opening";
			root: FlowRoot;
			path: string;
			via: CommitVia;
			provider: string | null;
			phase: "grace" | "staged";
			stage: 0 | 1 | 2;
	  }
	| { id: "reveal"; books: number; authors: number }
	| { id: "broken"; retry: "idle" | "checking" | "failed" }
	| { id: "done"; landing: "grid" | "empty"; path: string };

export interface FlowSnapshot {
	detection: Detection | null;
	/** Configured-but-unreachable path: the broken card's well + retry target. */
	brokenPath: string | null;
	/** True once the flow has committed to a library; the app may mount. */
	committed: boolean;
	step: FlowStep;
}

export type FlowEffect =
	| { kind: "detect" }
	| { kind: "load-default-path" }
	| { kind: "open-adopt-picker" }
	| { kind: "open-create-target-picker" }
	| { kind: "validate"; path: string }
	| { kind: "check-sync"; path: string }
	| { kind: "create-library"; path: string }
	/** Settings commit: `createLibrary(path)` + `setActiveLibrary(id)`. */
	| { kind: "commit-library"; path: string }
	| { kind: "revalidate"; path: string }
	/** Retry succeeded on the already-configured library: restart a failed
	 * store initialization (settings don't change, so nothing else would). */
	| { kind: "reopen-library"; path: string };

export type FlowEvent =
	| { type: "DETECTED"; detection: Detection | null }
	| { type: "USE_FOUND" }
	| { type: "CHOOSE_ADOPT" }
	| { type: "CHOOSE_CREATE" }
	| { type: "ADOPT_PICKED"; path: string }
	| { type: "ADOPT_PICK_CANCELLED" }
	| { type: "VALIDATION_SLOW" }
	| { type: "VALIDATED"; valid: boolean }
	| { type: "CROSS_CREATE_HERE" }
	| { type: "DEFAULT_PATH_LOADED"; path: string }
	| { type: "CHANGE_CREATE_TARGET" }
	| { type: "CREATE_TARGET_PICKED"; path: string }
	| { type: "CREATE_TARGET_CANCELLED" }
	| { type: "COMMIT_CREATE" }
	| { type: "SYNC_RESULT"; synced: boolean; provider: string | null }
	| { type: "CLOUD_CONTINUE" }
	| { type: "CLOUD_CANCEL" }
	| { type: "CREATED" }
	| { type: "CREATE_FAILED"; code: CreateErrorCode; message: string }
	| { type: "OPEN_INSTEAD" }
	| { type: "GRACE_ELAPSED" }
	| { type: "OPEN_CONNECTED" }
	| { type: "OPEN_METADATA_LOADED" }
	| { type: "OPEN_READY"; books: number; authors: number }
	| { type: "OPEN_FAILED" }
	| { type: "RETRY" }
	| { type: "RETRY_RESULT"; ok: boolean }
	| { type: "SHOW_BOOKS" }
	| { type: "BACK" }
	| { type: "ESCAPE" };

export type FlowMode =
	| { kind: "first-run" }
	| { kind: "broken-path"; path: string };

export interface TransitionResult {
	snapshot: FlowSnapshot;
	effects: FlowEffect[];
}

export const initFlow = (mode: FlowMode): TransitionResult =>
	mode.kind === "first-run"
		? {
				snapshot: {
					detection: null,
					brokenPath: null,
					committed: false,
					step: { id: "detecting" },
				},
				effects: [{ kind: "detect" }],
			}
		: {
				snapshot: {
					detection: null,
					brokenPath: mode.path,
					committed: false,
					step: { id: "broken", retry: "idle" },
				},
				effects: [],
			};

const same = (snapshot: FlowSnapshot): TransitionResult => ({
	snapshot,
	effects: [],
});

const to = (
	snapshot: FlowSnapshot,
	step: FlowStep,
	effects: FlowEffect[] = [],
): TransitionResult => ({ snapshot: { ...snapshot, step }, effects });

/** The step a Back/cancel from a sub-screen returns to. */
const rootStep = (root: FlowRoot): FlowStep => {
	switch (root) {
		case "found":
			return { id: "found" };
		case "chooser":
			return { id: "chooser" };
		case "broken":
			return { id: "broken", retry: "idle" };
	}
};

const freshCreate = (
	root: FlowRoot,
	overrides?: { path: string; fromInvalid: string | null },
): FlowStep => ({
	id: "create",
	root,
	path: overrides?.path ?? null,
	defaultPath: null,
	fromInvalid: overrides?.fromInvalid ?? null,
	error: null,
	busy: false,
	picking: false,
});

const restoreCreate = (
	create: CreateReturn,
	error: CreateError | null,
	busy = false,
): FlowStep => ({
	id: "create",
	root: create.root,
	path: create.path,
	defaultPath: create.defaultPath,
	fromInvalid: create.fromInvalid,
	error,
	busy,
	picking: false,
});

const createErrorFor = (
	code: CreateErrorCode,
	message: string,
): CreateError => {
	switch (code) {
		case "folder-not-empty":
			return { code, message: CREATE_NONEMPTY_ERROR };
		case "already-a-library":
			return { code, message: CREATE_EXISTING_ERROR };
		case "create-failed":
			return { code, message };
	}
};

/** Root-screen navigation shared by found, chooser, and broken. */
const fromRoot = (
	snapshot: FlowSnapshot,
	root: FlowRoot,
	event: FlowEvent,
): TransitionResult | null => {
	switch (event.type) {
		case "CHOOSE_ADOPT":
			return to(snapshot, { id: "picking", root }, [
				{ kind: "open-adopt-picker" },
			]);
		case "CHOOSE_CREATE":
			return to(snapshot, freshCreate(root), [{ kind: "load-default-path" }]);
		default:
			return null;
	}
};

/** Proceed with a gated commit after the sync check clears (or the user
 * chooses Continue on the cloud warning). */
const proceed = (
	snapshot: FlowSnapshot,
	root: FlowRoot,
	path: string,
	commit: CommitKind,
): TransitionResult => {
	if (commit.kind === "create") {
		return {
			snapshot: {
				...snapshot,
				step: restoreCreate(commit.create, null, true),
			},
			effects: [{ kind: "create-library", path }],
		};
	}
	// When the cloud warning was the screen that committed, the grace window
	// holds it (Continue becomes the inline spinner) instead of flashing the
	// root the user left two steps ago.
	const warned = snapshot.step.id === "cloud-warn" ? snapshot.step : null;
	const via: CommitVia = warned
		? "cloud-warn"
		: commit.kind === "adopt-found"
			? "found"
			: commit.kind === "adopt-picked"
				? "picker"
				: "open-instead";
	return {
		snapshot: {
			...snapshot,
			committed: true,
			step: {
				id: "opening",
				root,
				path,
				via,
				provider: warned?.provider ?? null,
				phase: "grace",
				stage: 0,
			},
		},
		effects: [{ kind: "commit-library", path }],
	};
};

/** Cancel out of the cloud warning back to the exact screen that committed. */
const cancelCommit = (
	snapshot: FlowSnapshot,
	root: FlowRoot,
	commit: CommitKind,
): TransitionResult => {
	switch (commit.kind) {
		case "adopt-found":
			return to(snapshot, { id: "found" });
		case "adopt-picked":
			return to(snapshot, { id: "picking", root }, [
				{ kind: "open-adopt-picker" },
			]);
		case "adopt-open-instead":
			return to(
				snapshot,
				restoreCreate(
					commit.create,
					createErrorFor("already-a-library", CREATE_EXISTING_ERROR),
				),
			);
		case "create":
			return to(snapshot, restoreCreate(commit.create, null));
	}
};

export const transition = (
	snapshot: FlowSnapshot,
	event: FlowEvent,
): TransitionResult => {
	const { step } = snapshot;

	switch (step.id) {
		case "detecting": {
			if (event.type === "DETECTED") {
				return {
					snapshot: {
						...snapshot,
						detection: event.detection,
						step: event.detection ? { id: "found" } : { id: "chooser" },
					},
					effects: [],
				};
			}
			return same(snapshot);
		}

		case "found": {
			if (event.type === "USE_FOUND" && snapshot.detection) {
				const path = snapshot.detection.path;
				return to(
					snapshot,
					{
						id: "sync-check",
						root: "found",
						path,
						commit: { kind: "adopt-found" },
					},
					[{ kind: "check-sync", path }],
				);
			}
			return fromRoot(snapshot, "found", event) ?? same(snapshot);
		}

		case "chooser":
			return fromRoot(snapshot, "chooser", event) ?? same(snapshot);

		case "broken": {
			if (event.type === "RETRY" && step.retry !== "checking") {
				if (!snapshot.brokenPath) return same(snapshot);
				return to(snapshot, { id: "broken", retry: "checking" }, [
					{ kind: "revalidate", path: snapshot.brokenPath },
				]);
			}
			if (event.type === "RETRY_RESULT" && step.retry === "checking") {
				if (!event.ok) return to(snapshot, { id: "broken", retry: "failed" });
				const path = snapshot.brokenPath ?? "";
				return {
					snapshot: {
						...snapshot,
						committed: true,
						step: {
							id: "opening",
							root: "broken",
							path,
							via: "retry",
							provider: null,
							phase: "grace",
							stage: 0,
						},
					},
					effects: [{ kind: "reopen-library", path }],
				};
			}
			if (step.retry === "checking") return same(snapshot);
			return fromRoot(snapshot, "broken", event) ?? same(snapshot);
		}

		case "picking": {
			if (event.type === "ADOPT_PICKED") {
				return to(
					snapshot,
					{ id: "validating", root: step.root, path: event.path, slow: false },
					[{ kind: "validate", path: event.path }],
				);
			}
			if (event.type === "ADOPT_PICK_CANCELLED") {
				return to(snapshot, rootStep(step.root));
			}
			return same(snapshot);
		}

		case "validating": {
			switch (event.type) {
				case "VALIDATION_SLOW":
					return to(snapshot, { ...step, slow: true });
				case "VALIDATED":
					if (event.valid) {
						return to(
							snapshot,
							{
								id: "sync-check",
								root: step.root,
								path: step.path,
								commit: { kind: "adopt-picked" },
							},
							[{ kind: "check-sync", path: step.path }],
						);
					}
					return to(snapshot, {
						id: "adopt-invalid",
						root: step.root,
						path: step.path,
					});
				case "BACK":
				case "ESCAPE":
					return to(snapshot, { id: "picking", root: step.root }, [
						{ kind: "open-adopt-picker" },
					]);
				default:
					return same(snapshot);
			}
		}

		case "adopt-invalid": {
			switch (event.type) {
				case "CHOOSE_ADOPT":
					return to(snapshot, { id: "picking", root: step.root }, [
						{ kind: "open-adopt-picker" },
					]);
				case "CROSS_CREATE_HERE":
					return to(
						snapshot,
						freshCreate(step.root, { path: step.path, fromInvalid: step.path }),
					);
				case "BACK":
				case "ESCAPE":
					return to(snapshot, rootStep(step.root));
				default:
					return same(snapshot);
			}
		}

		case "create": {
			switch (event.type) {
				case "DEFAULT_PATH_LOADED":
					if (step.path !== null) return same(snapshot);
					return to(snapshot, {
						...step,
						path: event.path,
						defaultPath: event.path,
					});
				case "CHANGE_CREATE_TARGET":
					if (step.busy || step.picking) return same(snapshot);
					return to(snapshot, { ...step, picking: true }, [
						{ kind: "open-create-target-picker" },
					]);
				case "CREATE_TARGET_PICKED":
					return to(snapshot, {
						...step,
						picking: false,
						path: event.path,
						error: null,
					});
				case "CREATE_TARGET_CANCELLED":
					return to(snapshot, { ...step, picking: false });
				case "COMMIT_CREATE": {
					if (step.busy || step.picking || step.error || step.path === null) {
						return same(snapshot);
					}
					const create: CreateReturn = {
						root: step.root,
						path: step.path,
						defaultPath: step.defaultPath,
						fromInvalid: step.fromInvalid,
					};
					return to(
						snapshot,
						{
							id: "sync-check",
							root: step.root,
							path: step.path,
							commit: { kind: "create", create },
						},
						[{ kind: "check-sync", path: step.path }],
					);
				}
				case "CREATED":
					if (!step.busy || step.path === null) return same(snapshot);
					return {
						snapshot: { ...snapshot, committed: true, step },
						effects: [{ kind: "commit-library", path: step.path }],
					};
				case "CREATE_FAILED":
					if (!step.busy) return same(snapshot);
					return to(snapshot, {
						...step,
						busy: false,
						error: createErrorFor(event.code, event.message),
					});
				case "OPEN_INSTEAD": {
					if (step.error?.code !== "already-a-library" || step.path === null) {
						return same(snapshot);
					}
					const create: CreateReturn = {
						root: step.root,
						path: step.path,
						defaultPath: step.defaultPath,
						fromInvalid: step.fromInvalid,
					};
					return to(
						snapshot,
						{
							id: "sync-check",
							root: step.root,
							path: step.path,
							commit: { kind: "adopt-open-instead", create },
						},
						[{ kind: "check-sync", path: step.path }],
					);
				}
				case "OPEN_READY":
					if (!step.busy || !snapshot.committed || step.path === null) {
						return same(snapshot);
					}
					return to(snapshot, {
						id: "done",
						landing: "empty",
						path: step.path,
					});
				case "OPEN_FAILED":
					if (!step.busy || !snapshot.committed) return same(snapshot);
					return {
						snapshot: {
							...snapshot,
							brokenPath: step.path,
							step: { id: "broken", retry: "idle" },
						},
						effects: [],
					};
				case "BACK":
				case "ESCAPE":
					if (step.busy || step.picking) return same(snapshot);
					return to(
						snapshot,
						step.fromInvalid
							? { id: "adopt-invalid", root: step.root, path: step.fromInvalid }
							: rootStep(step.root),
					);
				default:
					return same(snapshot);
			}
		}

		case "sync-check": {
			if (event.type === "SYNC_RESULT") {
				if (event.synced) {
					return to(snapshot, {
						id: "cloud-warn",
						root: step.root,
						path: step.path,
						provider: event.provider ?? "A cloud service",
						commit: step.commit,
					});
				}
				return proceed(snapshot, step.root, step.path, step.commit);
			}
			return same(snapshot);
		}

		case "cloud-warn": {
			switch (event.type) {
				case "CLOUD_CONTINUE":
					return proceed(snapshot, step.root, step.path, step.commit);
				case "CLOUD_CANCEL":
				case "BACK":
				case "ESCAPE":
					return cancelCommit(snapshot, step.root, step.commit);
				default:
					return same(snapshot);
			}
		}

		case "opening": {
			switch (event.type) {
				case "OPEN_CONNECTED":
					return to(snapshot, {
						...step,
						stage: step.stage < 1 ? 1 : step.stage,
					});
				case "OPEN_METADATA_LOADED":
					return to(snapshot, { ...step, stage: 2 });
				case "GRACE_ELAPSED":
					if (step.phase !== "grace") return same(snapshot);
					return to(snapshot, { ...step, phase: "staged" });
				case "OPEN_READY":
					if (event.books === 0) {
						return to(snapshot, {
							id: "done",
							landing: "empty",
							path: step.path,
						});
					}
					return to(snapshot, {
						id: "reveal",
						books: event.books,
						authors: event.authors,
					});
				case "OPEN_FAILED":
					return {
						snapshot: {
							...snapshot,
							brokenPath: step.path,
							step: { id: "broken", retry: "idle" },
						},
						effects: [],
					};
				default:
					return same(snapshot);
			}
		}

		case "reveal": {
			if (event.type === "SHOW_BOOKS") {
				return to(snapshot, { id: "done", landing: "grid", path: "" });
			}
			return same(snapshot);
		}

		case "done":
			return same(snapshot);
	}
};
