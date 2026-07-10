import { describe, expect, it } from "vitest";
import type {
	FlowEffect,
	FlowEvent,
	FlowSnapshot,
	TransitionResult,
} from "./machine";
import {
	CREATE_EXISTING_ERROR,
	CREATE_NONEMPTY_ERROR,
	initFlow,
	transition,
} from "./machine";

const CALIBRE = "/Users/reader/Books/Calibre Library";
const PLAIN = "/Users/reader/Documents/Books";
const CITADEL = "/Users/reader/Citadel";
const BROKEN = "/Volumes/T7/Calibre Library";

/** Run a sequence of events, returning the final snapshot and every effect
 * emitted along the way (in order). */
const run = (
	start: TransitionResult,
	events: FlowEvent[],
): { snapshot: FlowSnapshot; effects: FlowEffect[] } => {
	let snapshot = start.snapshot;
	const effects = [...start.effects];
	for (const event of events) {
		const result = transition(snapshot, event);
		snapshot = result.snapshot;
		effects.push(...result.effects);
	}
	return { snapshot, effects };
};

const kinds = (effects: FlowEffect[]) => effects.map((effect) => effect.kind);

const firstRun = () => initFlow({ kind: "first-run" });
const brokenBoot = () => initFlow({ kind: "broken-path", path: BROKEN });

const detected = (
	source: "calibre-config" | "default-folder" = "calibre-config",
): FlowEvent => ({ type: "DETECTED", detection: { path: CALIBRE, source } });

describe("boot decision", () => {
	it("first-run starts detecting and requests detection", () => {
		const { snapshot, effects } = firstRun();
		expect(snapshot.step).toEqual({ id: "detecting" });
		expect(kinds(effects)).toEqual(["detect"]);
	});

	it("a detection hit lands on found-confirm with provenance", () => {
		const { snapshot } = run(firstRun(), [detected("default-folder")]);
		expect(snapshot.step.id).toBe("found");
		expect(snapshot.detection).toEqual({
			path: CALIBRE,
			source: "default-folder",
		});
	});

	it("no detection lands on the chooser", () => {
		const { snapshot } = run(firstRun(), [
			{ type: "DETECTED", detection: null },
		]);
		expect(snapshot.step).toEqual({ id: "chooser" });
	});

	it("broken-path boots straight to the broken card with the path", () => {
		const { snapshot, effects } = brokenBoot();
		expect(snapshot.step).toEqual({ id: "broken", retry: "idle" });
		expect(snapshot.brokenPath).toBe(BROKEN);
		expect(effects).toEqual([]);
	});
});

describe("found-confirm commit (Use This Library)", () => {
	it("runs the sync check before committing", () => {
		const { snapshot, effects } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
		]);
		expect(snapshot.step).toMatchObject({
			id: "sync-check",
			path: CALIBRE,
			commit: { kind: "adopt-found" },
		});
		expect(effects).toContainEqual({ kind: "check-sync", path: CALIBRE });
	});

	it("clean sync commits: settings effect + grace-phase opening", () => {
		const { snapshot, effects } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
		]);
		expect(snapshot.committed).toBe(true);
		expect(snapshot.step).toMatchObject({
			id: "opening",
			via: "found",
			phase: "grace",
			stage: 0,
		});
		expect(effects).toContainEqual({ kind: "commit-library", path: CALIBRE });
	});

	it("instant branch: ready inside the grace window skips the stage list", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "OPEN_CONNECTED" },
			{ type: "OPEN_METADATA_LOADED" },
			{ type: "OPEN_READY", books: 1204, authors: 87 },
		]);
		expect(snapshot.step).toEqual({ id: "reveal", books: 1204, authors: 87 });
	});

	it("slow branch: grace elapses into the staged list, stages advance, then reveal", () => {
		const opening = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "GRACE_ELAPSED" },
		]);
		expect(opening.snapshot.step).toMatchObject({
			id: "opening",
			phase: "staged",
			stage: 0,
		});

		const staged = run({ snapshot: opening.snapshot, effects: [] }, [
			{ type: "OPEN_CONNECTED" },
			{ type: "OPEN_METADATA_LOADED" },
		]);
		expect(staged.snapshot.step).toMatchObject({ id: "opening", stage: 2 });

		const done = run({ snapshot: staged.snapshot, effects: [] }, [
			{ type: "OPEN_READY", books: 12, authors: 4 },
		]);
		expect(done.snapshot.step).toEqual({ id: "reveal", books: 12, authors: 4 });
	});

	it("stage progress arriving during grace is kept when the list mounts", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "OPEN_CONNECTED" },
			{ type: "GRACE_ELAPSED" },
		]);
		expect(snapshot.step).toMatchObject({
			id: "opening",
			phase: "staged",
			stage: 1,
		});
	});

	it("zero books on adopt skips the reveal and lands on the empty state with the path", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "OPEN_READY", books: 0, authors: 0 },
		]);
		expect(snapshot.step).toEqual({
			id: "done",
			landing: "empty",
			path: CALIBRE,
		});
	});

	it("the reveal's continue action dissolves into the grid", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "OPEN_READY", books: 1204, authors: 87 },
			{ type: "SHOW_BOOKS" },
		]);
		expect(snapshot.step).toMatchObject({ id: "done", landing: "grid" });
	});
});

describe("adopt via the picker", () => {
	const toPicker = (): TransitionResult =>
		run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_ADOPT" },
		]) as TransitionResult;

	it("chooser -> picker opens the native sheet", () => {
		const { snapshot, effects } = toPicker();
		expect(snapshot.step).toEqual({ id: "picking", root: "chooser" });
		expect(kinds(effects)).toContain("open-adopt-picker");
	});

	it("cancel returns to the root the user came from", () => {
		const fromChooser = run(toPicker(), [{ type: "ADOPT_PICK_CANCELLED" }]);
		expect(fromChooser.snapshot.step).toEqual({ id: "chooser" });

		const fromFound = run(firstRun(), [
			detected(),
			{ type: "CHOOSE_ADOPT" },
			{ type: "ADOPT_PICK_CANCELLED" },
		]);
		expect(fromFound.snapshot.step).toEqual({ id: "found" });
	});

	it("a pick validates; a slow validation flips the spinner state", () => {
		const { snapshot, effects } = run(toPicker(), [
			{ type: "ADOPT_PICKED", path: CALIBRE },
		]);
		expect(snapshot.step).toMatchObject({
			id: "validating",
			path: CALIBRE,
			slow: false,
		});
		expect(effects).toContainEqual({ kind: "validate", path: CALIBRE });

		const slow = run({ snapshot, effects: [] }, [{ type: "VALIDATION_SLOW" }]);
		expect(slow.snapshot.step).toMatchObject({ id: "validating", slow: true });
	});

	it("a valid pick sync-checks then commits via the picker", () => {
		const { snapshot, effects } = run(toPicker(), [
			{ type: "ADOPT_PICKED", path: CALIBRE },
			{ type: "VALIDATED", valid: true },
			{ type: "SYNC_RESULT", synced: false, provider: null },
		]);
		expect(snapshot.committed).toBe(true);
		expect(snapshot.step).toMatchObject({
			id: "opening",
			via: "picker",
			phase: "grace",
		});
		expect(effects).toContainEqual({ kind: "commit-library", path: CALIBRE });
	});

	it("an invalid pick shows the specific error; nothing is created", () => {
		const { snapshot, effects } = run(toPicker(), [
			{ type: "ADOPT_PICKED", path: PLAIN },
			{ type: "VALIDATED", valid: false },
		]);
		expect(snapshot.step).toEqual({
			id: "adopt-invalid",
			root: "chooser",
			path: PLAIN,
		});
		expect(kinds(effects)).not.toContain("create-library");
		expect(kinds(effects)).not.toContain("commit-library");
	});
});

describe("crossover: invalid pick -> Start a New Library Here", () => {
	const toInvalid = (): TransitionResult =>
		run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_ADOPT" },
			{ type: "ADOPT_PICKED", path: PLAIN },
			{ type: "VALIDATED", valid: false },
		]) as TransitionResult;

	it("enters create pre-filled with the picked path, without loading the default", () => {
		const { snapshot, effects } = run(toInvalid(), [
			{ type: "CROSS_CREATE_HERE" },
		]);
		expect(snapshot.step).toMatchObject({
			id: "create",
			path: PLAIN,
			fromInvalid: PLAIN,
		});
		expect(kinds(effects)).not.toContain("load-default-path");
	});

	it("Back from crossover-entered create returns to the invalid-pick context, then to the root", () => {
		const inCreate = run(toInvalid(), [{ type: "CROSS_CREATE_HERE" }]);
		const backOnce = run({ snapshot: inCreate.snapshot, effects: [] }, [
			{ type: "BACK" },
		]);
		expect(backOnce.snapshot.step).toEqual({
			id: "adopt-invalid",
			root: "chooser",
			path: PLAIN,
		});

		const backTwice = run({ snapshot: backOnce.snapshot, effects: [] }, [
			{ type: "BACK" },
		]);
		expect(backTwice.snapshot.step).toEqual({ id: "chooser" });
	});
});

describe("create path", () => {
	const toCreate = (): TransitionResult =>
		run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_CREATE" },
		]) as TransitionResult;

	it("loads the default path into the well", () => {
		const { snapshot, effects } = toCreate();
		expect(snapshot.step).toMatchObject({ id: "create", path: null });
		expect(kinds(effects)).toContain("load-default-path");

		const loaded = run({ snapshot, effects: [] }, [
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
		]);
		expect(loaded.snapshot.step).toMatchObject({
			id: "create",
			path: CITADEL,
			defaultPath: CITADEL,
		});
	});

	it("commit sync-checks first, then creates, commits, and lands on the empty state — never the reveal", () => {
		const { snapshot, effects } = run(toCreate(), [
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "CREATED" },
			{ type: "OPEN_READY", books: 0, authors: 0 },
		]);
		expect(snapshot.step).toEqual({
			id: "done",
			landing: "empty",
			path: CITADEL,
		});
		expect(kinds(effects)).toEqual([
			"detect",
			"load-default-path",
			"check-sync",
			"create-library",
			"commit-library",
		]);
	});

	it("create never reveals, even if the opened library reports books", () => {
		const { snapshot } = run(toCreate(), [
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "CREATED" },
			{ type: "OPEN_READY", books: 3, authors: 1 },
		]);
		expect(snapshot.step).toMatchObject({ id: "done", landing: "empty" });
	});

	it("maps folder-not-empty to its error state and re-arms after a new pick", () => {
		const failed = run(toCreate(), [
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{
				type: "CREATE_FAILED",
				code: "folder-not-empty",
				message: "create-library/folder-not-empty",
			},
		]);
		expect(failed.snapshot.step).toMatchObject({
			id: "create",
			busy: false,
			error: { code: "folder-not-empty", message: CREATE_NONEMPTY_ERROR },
		});

		const repicked = run({ snapshot: failed.snapshot, effects: [] }, [
			{ type: "CHANGE_CREATE_TARGET" },
			{ type: "CREATE_TARGET_PICKED", path: "/Users/reader/Books/Citadel" },
		]);
		expect(repicked.snapshot.step).toMatchObject({
			id: "create",
			path: "/Users/reader/Books/Citadel",
			error: null,
		});
	});

	it("commit is inert while an error is showing", () => {
		const failed = run(toCreate(), [
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{
				type: "CREATE_FAILED",
				code: "folder-not-empty",
				message: "create-library/folder-not-empty",
			},
		]);
		const retried = transition(failed.snapshot, { type: "COMMIT_CREATE" });
		expect(retried.snapshot).toEqual(failed.snapshot);
		expect(retried.effects).toEqual([]);
	});

	it("crossover: already-a-library offers Open It Instead, which adopts", () => {
		const failed = run(toCreate(), [
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{
				type: "CREATE_FAILED",
				code: "already-a-library",
				message: "create-library/already-a-library",
			},
		]);
		expect(failed.snapshot.step).toMatchObject({
			id: "create",
			error: { code: "already-a-library", message: CREATE_EXISTING_ERROR },
		});

		const adopted = run({ snapshot: failed.snapshot, effects: [] }, [
			{ type: "OPEN_INSTEAD" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
		]);
		expect(adopted.snapshot.committed).toBe(true);
		expect(adopted.snapshot.step).toMatchObject({
			id: "opening",
			via: "open-instead",
			path: CITADEL,
		});
		expect(adopted.effects).toContainEqual({
			kind: "commit-library",
			path: CITADEL,
		});
	});
});

describe("cloud warning interposes on both paths, warn-then-allow", () => {
	it("adopt: synced pick warns; Continue commits; Cancel reopens the picker", () => {
		const warned = run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_ADOPT" },
			{ type: "ADOPT_PICKED", path: CALIBRE },
			{ type: "VALIDATED", valid: true },
			{ type: "SYNC_RESULT", synced: true, provider: "iCloud Drive" },
		]);
		expect(warned.snapshot.step).toMatchObject({
			id: "cloud-warn",
			provider: "iCloud Drive",
		});

		const continued = run({ snapshot: warned.snapshot, effects: [] }, [
			{ type: "CLOUD_CONTINUE" },
		]);
		expect(continued.snapshot.step).toMatchObject({
			id: "opening",
			via: "picker",
		});
		expect(continued.effects).toContainEqual({
			kind: "commit-library",
			path: CALIBRE,
		});

		const cancelled = run({ snapshot: warned.snapshot, effects: [] }, [
			{ type: "CLOUD_CANCEL" },
		]);
		expect(cancelled.snapshot.step).toEqual({
			id: "picking",
			root: "chooser",
		});
		expect(kinds(cancelled.effects)).toContain("open-adopt-picker");
	});

	it("adopt via found: Cancel returns to found-confirm", () => {
		const cancelled = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: true, provider: "Dropbox" },
			{ type: "CLOUD_CANCEL" },
		]);
		expect(cancelled.snapshot.step).toEqual({ id: "found" });
		expect(cancelled.snapshot.committed).toBe(false);
	});

	it("create: synced target warns before anything is created; Cancel keeps the chosen path", () => {
		const warned = run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_CREATE" },
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "CHANGE_CREATE_TARGET" },
			{ type: "CREATE_TARGET_PICKED", path: "/Users/reader/Dropbox/Citadel" },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: true, provider: "Dropbox" },
		]);
		expect(warned.snapshot.step).toMatchObject({
			id: "cloud-warn",
			provider: "Dropbox",
			commit: { kind: "create" },
		});
		expect(kinds(warned.effects)).not.toContain("create-library");

		const cancelled = run({ snapshot: warned.snapshot, effects: [] }, [
			{ type: "CLOUD_CANCEL" },
		]);
		expect(cancelled.snapshot.step).toMatchObject({
			id: "create",
			path: "/Users/reader/Dropbox/Citadel",
			busy: false,
		});

		const continued = run({ snapshot: warned.snapshot, effects: [] }, [
			{ type: "CLOUD_CONTINUE" },
		]);
		expect(continued.snapshot.step).toMatchObject({ id: "create", busy: true });
		expect(continued.effects).toContainEqual({
			kind: "create-library",
			path: "/Users/reader/Dropbox/Citadel",
		});
	});

	it("a missing provider name falls back to generic copy", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: true, provider: null },
		]);
		expect(snapshot.step).toMatchObject({
			id: "cloud-warn",
			provider: "A cloud service",
		});
	});
});

describe("broken-path variant", () => {
	it("retry revalidates; failure shows the note and stays retryable", () => {
		const checking = run(brokenBoot(), [{ type: "RETRY" }]);
		expect(checking.snapshot.step).toEqual({ id: "broken", retry: "checking" });
		expect(checking.effects).toContainEqual({
			kind: "revalidate",
			path: BROKEN,
		});

		const failed = run({ snapshot: checking.snapshot, effects: [] }, [
			{ type: "RETRY_RESULT", ok: false },
		]);
		expect(failed.snapshot.step).toEqual({ id: "broken", retry: "failed" });

		// The retry loop: fail again, then succeed.
		const secondTry = run({ snapshot: failed.snapshot, effects: [] }, [
			{ type: "RETRY" },
			{ type: "RETRY_RESULT", ok: false },
			{ type: "RETRY" },
			{ type: "RETRY_RESULT", ok: true },
		]);
		expect(secondTry.snapshot.committed).toBe(true);
		expect(secondTry.snapshot.step).toMatchObject({
			id: "opening",
			via: "retry",
			path: BROKEN,
			phase: "grace",
		});
		// The library is already the configured one — no settings rewrite,
		// just a restart of the failed store initialization.
		expect(kinds(secondTry.effects)).not.toContain("commit-library");
		expect(secondTry.effects).toContainEqual({
			kind: "reopen-library",
			path: BROKEN,
		});
	});

	it("retry-recovered library opens through the staged flow to the reveal", () => {
		const { snapshot } = run(brokenBoot(), [
			{ type: "RETRY" },
			{ type: "RETRY_RESULT", ok: true },
			{ type: "GRACE_ELAPSED" },
			{ type: "OPEN_CONNECTED" },
			{ type: "OPEN_METADATA_LOADED" },
			{ type: "OPEN_READY", books: 240, authors: 31 },
		]);
		expect(snapshot.step).toEqual({ id: "reveal", books: 240, authors: 31 });
	});

	it("offers the same escapes as the chooser, returning to broken on cancel", () => {
		const picking = run(brokenBoot(), [{ type: "CHOOSE_ADOPT" }]);
		expect(picking.snapshot.step).toEqual({ id: "picking", root: "broken" });

		const cancelled = run({ snapshot: picking.snapshot, effects: [] }, [
			{ type: "ADOPT_PICK_CANCELLED" },
		]);
		expect(cancelled.snapshot.step).toEqual({ id: "broken", retry: "idle" });
	});

	it("an open failure mid-flow falls back to the broken card with that path", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "OPEN_FAILED" },
		]);
		expect(snapshot.step).toEqual({ id: "broken", retry: "idle" });
		expect(snapshot.brokenPath).toBe(CALIBRE);
	});
});

describe("Escape policy", () => {
	it("is inert at the roots, during opening, and on the reveal", () => {
		const roots: FlowSnapshot[] = [
			run(firstRun(), [detected()]).snapshot,
			run(firstRun(), [{ type: "DETECTED", detection: null }]).snapshot,
			brokenBoot().snapshot,
			run(firstRun(), [
				detected(),
				{ type: "USE_FOUND" },
				{ type: "SYNC_RESULT", synced: false, provider: null },
				{ type: "GRACE_ELAPSED" },
			]).snapshot,
			run(firstRun(), [
				detected(),
				{ type: "USE_FOUND" },
				{ type: "SYNC_RESULT", synced: false, provider: null },
				{ type: "OPEN_READY", books: 500, authors: 40 },
			]).snapshot,
		];
		for (const snapshot of roots) {
			const result = transition(snapshot, { type: "ESCAPE" });
			expect(result.snapshot).toEqual(snapshot);
			expect(result.effects).toEqual([]);
		}
	});

	it("backs out of adopt-invalid, create, and cloud-warn", () => {
		const invalid = run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_ADOPT" },
			{ type: "ADOPT_PICKED", path: PLAIN },
			{ type: "VALIDATED", valid: false },
			{ type: "ESCAPE" },
		]);
		expect(invalid.snapshot.step).toEqual({ id: "chooser" });

		const create = run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_CREATE" },
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "ESCAPE" },
		]);
		expect(create.snapshot.step).toEqual({ id: "chooser" });

		const cloud = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: true, provider: "Dropbox" },
			{ type: "ESCAPE" },
		]);
		expect(cloud.snapshot.step).toEqual({ id: "found" });
	});

	it("is inert while create is mid-transaction", () => {
		const busy = run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "CHOOSE_CREATE" },
			{ type: "DEFAULT_PATH_LOADED", path: CITADEL },
			{ type: "COMMIT_CREATE" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
		]);
		expect(busy.snapshot.step).toMatchObject({ id: "create", busy: true });
		const escaped = transition(busy.snapshot, { type: "ESCAPE" });
		expect(escaped.snapshot).toEqual(busy.snapshot);
	});
});

describe("terminal + guard behavior", () => {
	it("done ignores everything", () => {
		const done = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "OPEN_READY", books: 500, authors: 40 },
			{ type: "SHOW_BOOKS" },
		]);
		const poked = transition(done.snapshot, { type: "RETRY" });
		expect(poked.snapshot).toEqual(done.snapshot);
	});

	it("Use This Library is inert without a detection", () => {
		const { snapshot } = run(firstRun(), [
			{ type: "DETECTED", detection: null },
			{ type: "USE_FOUND" },
		]);
		expect(snapshot.step).toEqual({ id: "chooser" });
	});

	it("grace elapsing twice does not regress a staged opening", () => {
		const { snapshot } = run(firstRun(), [
			detected(),
			{ type: "USE_FOUND" },
			{ type: "SYNC_RESULT", synced: false, provider: null },
			{ type: "GRACE_ELAPSED" },
			{ type: "GRACE_ELAPSED" },
		]);
		expect(snapshot.step).toMatchObject({ id: "opening", phase: "staged" });
	});
});
