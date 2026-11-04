import type {
	ChooseLibrary,
	DirectoryListing,
	FoundLibraries,
	PathInspection,
	ServedLibrary,
} from "@/lib/services/library-catalog/types";

/**
 * CDL-39 web setup — pure state machine (functional core).
 *
 * The browser's counterpart to the desktop first-run flow, for the server an
 * administrator has just created themselves on: choose a folder on the
 * server, by typing or browsing, see what is there, then create a library
 * or adopt the one found. `transition(snapshot, event)` returns the next
 * snapshot plus one-shot effects for the shell (`use-web-setup-flow.ts`),
 * which talks to the server through LibraryCatalog's setup operations.
 */

export const EMPTY_PATH_ERROR =
	"Enter a folder on the server, such as /srv/books.";
export const ALREADY_A_LIBRARY_ERROR =
	"This folder is already a Calibre library.";
export const NOT_A_LIBRARY_ERROR =
	"No metadata.db inside. If your library lives in a subfolder, choose that folder instead.";
export const UPGRADE_PROMPT =
	"Upgrade this library to Calibre's current format? A backup is kept.";
export const READ_ONLY_PROMPT = "Read-only";
export const READ_ONLY_DESCRIPTION =
	"For a library you keep managing in Calibre on another computer. Citadel won't change it, so adding and editing books is off.";

const NOTHING_FOUND: FoundLibraries = { libraries: [], createIn: [] };

export type SetupMode = "create" | "adopt";
/** Which root screen the user came from; Back returns here. */
export type SetupRoot = "chooser" | "broken";

export interface FolderBrowser {
	/** The folder whose subfolders are listed, or being listed. */
	path: string;
	listing: DirectoryListing | null;
	loading: boolean;
	error: string | null;
}

/** What the inspection means for the chosen mode. */
export type PathVerdict =
	| { kind: "ok" }
	| { kind: "unchecked" }
	| { kind: "checking" }
	/** The folder holds the other thing: a library when creating, or room
	 * for one when adopting. The crossover switches modes in place. */
	| { kind: "crossover"; message: string }
	| { kind: "error"; message: string };

export type SetupStep =
	| { id: "loading" }
	| { id: "unavailable"; message: string }
	| { id: "chooser" }
	| {
			id: "broken";
			library: ServedLibrary;
			retry: "idle" | "checking" | "failed";
	  }
	| {
			id: "path";
			mode: SetupMode;
			root: SetupRoot;
			path: string;
			/** The server's view of `path`, cleared whenever the path changes. */
			inspection: PathInspection | null;
			checking: boolean;
			/** Continue was pressed before the inspection answered. */
			continueWhenChecked: boolean;
			error: string | null;
			browser: FolderBrowser | null;
	  }
	| {
			id: "confirm";
			mode: SetupMode;
			root: SetupRoot;
			path: string;
			inspection: PathInspection;
			name: string;
			upgrade: boolean;
			/** Serve it without changes; forced on when the server can't write it. */
			readOnly: boolean;
			/** Picked from the chooser's found libraries, so Back returns there. */
			fromChooser: boolean;
			busy: boolean;
			error: string | null;
	  }
	| { id: "reveal"; books: number; authors: number }
	| { id: "done" };

export interface SetupSnapshot {
	/** Where the folder browser opens when the path field is empty. */
	browseRoot: string | null;
	/** What the server found in the folders mounted for libraries. */
	found: FoundLibraries;
	/** The registered library as last reported, open or not. */
	library: ServedLibrary | null;
	step: SetupStep;
}

export type SetupEffect =
	| { kind: "load-status" }
	| { kind: "inspect"; path: string }
	| { kind: "list"; path: string | null }
	| { kind: "commit"; request: ChooseLibrary }
	| { kind: "reopen" };

export type SetupEvent =
	| {
			type: "STATUS_LOADED";
			library: ServedLibrary | null;
			browseRoot: string;
			found: FoundLibraries;
	  }
	| { type: "STATUS_FAILED"; message: string }
	| { type: "RETRY" }
	| { type: "REOPENED"; library: ServedLibrary }
	| { type: "REOPEN_FAILED"; message: string }
	| { type: "CHOOSE_CREATE" }
	| { type: "CHOOSE_ADOPT" }
	/** A library the server found, by path. */
	| { type: "USE_FOUND"; path: string }
	/** An empty mounted folder the server found, by path. */
	| { type: "CREATE_IN"; path: string }
	| { type: "PATH_CHANGED"; path: string }
	| { type: "CONTINUE" }
	| { type: "INSPECTED"; path: string; inspection: PathInspection }
	| { type: "INSPECT_FAILED"; path: string; message: string }
	| { type: "SWITCH_MODE" }
	| { type: "OPEN_BROWSER" }
	| { type: "BROWSE_TO"; path: string | null }
	| { type: "LISTED"; listing: DirectoryListing }
	| { type: "LIST_FAILED"; message: string }
	| { type: "PICK"; path: string }
	| { type: "CLOSE_BROWSER" }
	| { type: "NAME_CHANGED"; name: string }
	| { type: "UPGRADE_CHANGED"; upgrade: boolean }
	| { type: "READ_ONLY_CHANGED"; readOnly: boolean }
	| { type: "COMMIT" }
	| { type: "COMMITTED"; library: ServedLibrary }
	| { type: "COMMIT_FAILED"; message: string }
	| { type: "SHOW_BOOKS" }
	| { type: "BACK" }
	| { type: "ESCAPE" };

export interface TransitionResult {
	snapshot: SetupSnapshot;
	effects: SetupEffect[];
}

export const initSetup = (): TransitionResult => ({
	snapshot: {
		browseRoot: null,
		found: NOTHING_FOUND,
		library: null,
		step: { id: "loading" },
	},
	effects: [{ kind: "load-status" }],
});

const same = (snapshot: SetupSnapshot): TransitionResult => ({
	snapshot,
	effects: [],
});

const to = (
	snapshot: SetupSnapshot,
	step: SetupStep,
	effects: SetupEffect[] = [],
): TransitionResult => ({ snapshot: { ...snapshot, step }, effects });

/** What the inspection means for `mode`, in the words the card shows. */
export const verdict = (
	mode: SetupMode,
	inspection: PathInspection | null,
	checking: boolean,
): PathVerdict => {
	if (checking) return { kind: "checking" };
	if (!inspection) return { kind: "unchecked" };
	const message = inspection.message;
	switch (inspection.status) {
		case "library":
			if (mode === "create")
				return { kind: "crossover", message: ALREADY_A_LIBRARY_ERROR };
			if (inspection.library?.supported) return { kind: "ok" };
			return {
				kind: "error",
				message: message ?? "This library can't be opened.",
			};
		case "empty":
		case "missing":
			if (mode === "create") return { kind: "ok" };
			return { kind: "crossover", message: NOT_A_LIBRARY_ERROR };
		default:
			return {
				kind: "error",
				message: message ?? "This folder can't be used.",
			};
	}
};

const freshPath = (
	mode: SetupMode,
	root: SetupRoot,
	path = "",
): Extract<SetupStep, { id: "path" }> => ({
	id: "path",
	mode,
	root,
	path,
	inspection: null,
	checking: false,
	continueWhenChecked: false,
	error: null,
	browser: null,
});

/** The step a Back from a sub-screen returns to. */
const rootStep = (snapshot: SetupSnapshot, root: SetupRoot): SetupStep =>
	root === "broken" && snapshot.library
		? { id: "broken", library: snapshot.library, retry: "idle" }
		: { id: "chooser" };

/** The server can't write this library, so it can only be read-only. */
export const mustBeReadOnly = (inspection: PathInspection): boolean =>
	inspection.library?.writable === false;

/** Enter the confirm step from an inspection that passed. */
const confirm = (
	snapshot: SetupSnapshot,
	from: { mode: SetupMode; root: SetupRoot },
	inspection: PathInspection,
	fromChooser = false,
): TransitionResult => {
	const readOnly = mustBeReadOnly(inspection);
	return to(snapshot, {
		id: "confirm",
		mode: from.mode,
		root: from.root,
		path: inspection.path,
		inspection,
		name: inspection.name,
		upgrade: !readOnly && (inspection.library?.upgradeAvailable ?? false),
		readOnly,
		fromChooser,
		busy: false,
		error: null,
	});
};

export const transition = (
	snapshot: SetupSnapshot,
	event: SetupEvent,
): TransitionResult => {
	const { step } = snapshot;

	switch (step.id) {
		case "loading": {
			if (event.type === "STATUS_LOADED") {
				const base = {
					...snapshot,
					browseRoot: event.browseRoot,
					found: event.found,
					library: event.library,
				};
				if (!event.library) return to(base, { id: "chooser" });
				if (event.library.available) return to(base, { id: "done" });
				return to(base, {
					id: "broken",
					library: event.library,
					retry: "idle",
				});
			}
			if (event.type === "STATUS_FAILED") {
				return to(snapshot, { id: "unavailable", message: event.message });
			}
			return same(snapshot);
		}

		case "unavailable": {
			if (event.type === "RETRY") {
				return to(snapshot, { id: "loading" }, [{ kind: "load-status" }]);
			}
			return same(snapshot);
		}

		case "chooser": {
			switch (event.type) {
				case "CHOOSE_CREATE":
					return to(snapshot, freshPath("create", "chooser"));
				case "CHOOSE_ADOPT":
					return to(snapshot, freshPath("adopt", "chooser"));
				case "USE_FOUND": {
					const found = snapshot.found.libraries.find(
						(library) => library.path === event.path,
					);
					if (!found || verdict("adopt", found, false).kind !== "ok") {
						return to(snapshot, {
							...freshPath("adopt", "chooser", event.path),
							inspection: found ?? null,
						});
					}
					return confirm(
						snapshot,
						{ mode: "adopt", root: "chooser" },
						found,
						true,
					);
				}
				case "CREATE_IN": {
					const found = snapshot.found.createIn.find(
						(spot) => spot.path === event.path,
					);
					if (!found) return same(snapshot);
					return confirm(
						snapshot,
						{ mode: "create", root: "chooser" },
						found,
						true,
					);
				}
				default:
					return same(snapshot);
			}
		}

		case "broken": {
			switch (event.type) {
				case "RETRY":
					if (step.retry === "checking") return same(snapshot);
					return to(snapshot, { ...step, retry: "checking" }, [
						{ kind: "reopen" },
					]);
				case "REOPENED": {
					const base = { ...snapshot, library: event.library };
					if (event.library.available) return to(base, { id: "done" });
					return to(base, {
						id: "broken",
						library: event.library,
						retry: "failed",
					});
				}
				case "REOPEN_FAILED":
					return to(snapshot, { ...step, retry: "failed" });
				case "CHOOSE_ADOPT":
					if (step.retry === "checking") return same(snapshot);
					return to(snapshot, freshPath("adopt", "broken", step.library.path));
				default:
					return same(snapshot);
			}
		}

		case "path": {
			switch (event.type) {
				case "PATH_CHANGED":
					return to(snapshot, {
						...step,
						path: event.path,
						inspection: null,
						continueWhenChecked: false,
						error: null,
					});
				case "CONTINUE": {
					if (step.browser) return same(snapshot);
					const path = step.path.trim();
					if (path === "") {
						return to(snapshot, { ...step, error: EMPTY_PATH_ERROR });
					}
					if (step.checking) {
						return to(snapshot, { ...step, continueWhenChecked: true });
					}
					if (step.inspection) {
						const result = verdict(step.mode, step.inspection, false);
						return result.kind === "ok"
							? confirm(snapshot, step, step.inspection)
							: same(snapshot);
					}
					return to(
						snapshot,
						{ ...step, checking: true, continueWhenChecked: true, error: null },
						[{ kind: "inspect", path }],
					);
				}
				case "INSPECTED": {
					if (event.path !== step.path.trim() || !step.checking) {
						return same(snapshot);
					}
					const result = verdict(step.mode, event.inspection, false);
					if (step.continueWhenChecked && result.kind === "ok") {
						return confirm(snapshot, step, event.inspection);
					}
					return to(snapshot, {
						...step,
						checking: false,
						continueWhenChecked: false,
						inspection: event.inspection,
						error: null,
					});
				}
				case "INSPECT_FAILED":
					if (event.path !== step.path.trim() || !step.checking) {
						return same(snapshot);
					}
					return to(snapshot, {
						...step,
						checking: false,
						continueWhenChecked: false,
						error: event.message,
					});
				case "SWITCH_MODE": {
					if (
						!step.inspection ||
						verdict(step.mode, step.inspection, false).kind !== "crossover"
					) {
						return same(snapshot);
					}
					const mode: SetupMode = step.mode === "create" ? "adopt" : "create";
					return to(snapshot, { ...step, mode, error: null });
				}
				case "OPEN_BROWSER": {
					if (step.browser) return same(snapshot);
					const start = step.path.trim() || snapshot.browseRoot;
					return to(
						snapshot,
						{
							...step,
							browser: {
								path: start ?? "",
								listing: null,
								loading: true,
								error: null,
							},
						},
						[{ kind: "list", path: start }],
					);
				}
				case "BROWSE_TO": {
					if (!step.browser) return same(snapshot);
					return to(
						snapshot,
						{
							...step,
							browser: {
								...step.browser,
								path: event.path ?? snapshot.browseRoot ?? "",
								loading: true,
								error: null,
							},
						},
						[{ kind: "list", path: event.path }],
					);
				}
				case "LISTED":
					if (!step.browser) return same(snapshot);
					return to(snapshot, {
						...step,
						browser: {
							path: event.listing.path,
							listing: event.listing,
							loading: false,
							error: null,
						},
					});
				case "LIST_FAILED":
					if (!step.browser) return same(snapshot);
					return to(snapshot, {
						...step,
						browser: { ...step.browser, loading: false, error: event.message },
					});
				case "PICK":
					if (!step.browser) return same(snapshot);
					return to(
						snapshot,
						{
							...step,
							path: event.path,
							inspection: null,
							checking: true,
							continueWhenChecked: false,
							error: null,
							browser: null,
						},
						[{ kind: "inspect", path: event.path }],
					);
				case "CLOSE_BROWSER":
					return to(snapshot, { ...step, browser: null });
				case "ESCAPE":
					if (step.browser) return to(snapshot, { ...step, browser: null });
					return to(snapshot, rootStep(snapshot, step.root));
				case "BACK":
					return to(snapshot, rootStep(snapshot, step.root));
				default:
					return same(snapshot);
			}
		}

		case "confirm": {
			switch (event.type) {
				case "NAME_CHANGED":
					if (step.busy) return same(snapshot);
					return to(snapshot, { ...step, name: event.name });
				case "UPGRADE_CHANGED":
					if (step.busy || step.readOnly) return same(snapshot);
					return to(snapshot, { ...step, upgrade: event.upgrade });
				case "READ_ONLY_CHANGED":
					if (step.busy || mustBeReadOnly(step.inspection)) {
						return same(snapshot);
					}
					return to(snapshot, {
						...step,
						readOnly: event.readOnly,
						// Upgrading writes, so it goes with read-only and comes back
						// with writable.
						upgrade:
							!event.readOnly &&
							(step.inspection.library?.upgradeAvailable ?? false),
					});
				case "COMMIT": {
					if (step.busy) return same(snapshot);
					const name = step.name.trim();
					return to(snapshot, { ...step, busy: true, error: null }, [
						{
							kind: "commit",
							request: {
								mode: step.mode,
								path: step.path,
								name: name === "" ? null : name,
								upgrade:
									step.mode === "adopt" && step.upgrade && !step.readOnly,
								readOnly: step.mode === "adopt" && step.readOnly,
							},
						},
					]);
				}
				case "COMMITTED": {
					if (!step.busy) return same(snapshot);
					if (step.mode === "adopt" && step.inspection.library) {
						return to(snapshot, {
							id: "reveal",
							books: step.inspection.library.bookCount,
							authors: step.inspection.library.authorCount,
						});
					}
					return to(snapshot, { id: "done" });
				}
				case "COMMIT_FAILED":
					if (!step.busy) return same(snapshot);
					return to(snapshot, { ...step, busy: false, error: event.message });
				case "BACK":
				case "ESCAPE":
					if (step.busy) return same(snapshot);
					if (step.fromChooser) return to(snapshot, { id: "chooser" });
					return to(snapshot, {
						...freshPath(step.mode, step.root, step.path),
						inspection: step.inspection,
					});
				default:
					return same(snapshot);
			}
		}

		case "reveal": {
			if (event.type === "SHOW_BOOKS") return to(snapshot, { id: "done" });
			return same(snapshot);
		}

		case "done":
			return same(snapshot);
	}
};
