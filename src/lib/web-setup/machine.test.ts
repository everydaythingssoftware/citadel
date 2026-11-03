import { describe, expect, it } from "vitest";
import type {
	PathInspection,
	ServedLibrary,
} from "@/lib/services/library-catalog/types";
import type {
	SetupEffect,
	SetupEvent,
	SetupSnapshot,
	TransitionResult,
} from "./machine";
import {
	ALREADY_A_LIBRARY_ERROR,
	EMPTY_PATH_ERROR,
	initSetup,
	NOT_A_LIBRARY_ERROR,
	transition,
	verdict,
} from "./machine";

const BOOKS = "/srv/books";
const ROOT = "/home/citadel";

const served = (patch: Partial<ServedLibrary> = {}): ServedLibrary => ({
	id: "f0b2afca",
	name: "Shelf",
	path: BOOKS,
	readOnly: false,
	available: true,
	problem: null,
	schemaVersion: 28,
	upgradeAvailable: false,
	...patch,
});

const inspection = (
	patch: Partial<PathInspection> & Pick<PathInspection, "status">,
): PathInspection => ({
	path: BOOKS,
	name: "books",
	library: null,
	message: null,
	...patch,
});

const library = (patch: Partial<PathInspection["library"]> = {}) =>
	inspection({
		status: "library",
		library: {
			bookCount: 1204,
			authorCount: 300,
			schemaVersion: 26,
			upgradeAvailable: true,
			supported: true,
			...patch,
		},
	});

const run = (
	start: TransitionResult,
	events: SetupEvent[],
): { snapshot: SetupSnapshot; effects: SetupEffect[] } => {
	let snapshot = start.snapshot;
	const effects = [...start.effects];
	for (const event of events) {
		const result = transition(snapshot, event);
		snapshot = result.snapshot;
		effects.push(...result.effects);
	}
	return { snapshot, effects };
};

const loaded = (library: ServedLibrary | null = null): SetupEvent => ({
	type: "STATUS_LOADED",
	library,
	browseRoot: ROOT,
});

describe("web setup machine", () => {
	it("loads the status first and lands on the chooser when nothing is served", () => {
		const start = initSetup();
		expect(start.effects).toEqual([{ kind: "load-status" }]);
		const { snapshot } = run(start, [loaded()]);
		expect(snapshot.step).toEqual({ id: "chooser" });
		expect(snapshot.browseRoot).toBe(ROOT);
	});

	it("is done at once when the served library is open, and broken when it isn't", () => {
		expect(run(initSetup(), [loaded(served())]).snapshot.step).toEqual({
			id: "done",
		});
		const broken = served({
			available: false,
			problem: "not a Calibre library",
		});
		expect(run(initSetup(), [loaded(broken)]).snapshot.step).toEqual({
			id: "broken",
			library: broken,
			retry: "idle",
		});
	});

	it("offers a retry when the status itself can't be read", () => {
		const { snapshot, effects } = run(initSetup(), [
			{ type: "STATUS_FAILED", message: "Couldn't reach the server." },
			{ type: "RETRY" },
		]);
		expect(snapshot.step).toEqual({ id: "loading" });
		expect(effects).toEqual([{ kind: "load-status" }, { kind: "load-status" }]);
	});

	it("inspects on Continue and goes straight to confirm when the folder suits", () => {
		const { snapshot, effects } = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_CREATE" },
			{ type: "PATH_CHANGED", path: ` ${BOOKS} ` },
			{ type: "CONTINUE" },
			{
				type: "INSPECTED",
				path: BOOKS,
				inspection: inspection({ status: "missing" }),
			},
		]);
		expect(effects).toEqual([
			{ kind: "load-status" },
			{ kind: "inspect", path: BOOKS },
		]);
		expect(snapshot.step).toMatchObject({
			id: "confirm",
			mode: "create",
			path: BOOKS,
			name: "books",
			upgrade: false,
		});
	});

	it("refuses an empty path without asking the server", () => {
		const { snapshot, effects } = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_ADOPT" },
			{ type: "CONTINUE" },
		]);
		expect(snapshot.step).toMatchObject({
			id: "path",
			error: EMPTY_PATH_ERROR,
		});
		expect(effects).toEqual([{ kind: "load-status" }]);
	});

	it("drops inspections for a path the user has since changed", () => {
		const { snapshot } = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_CREATE" },
			{ type: "PATH_CHANGED", path: "/old" },
			{ type: "CONTINUE" },
			{ type: "PATH_CHANGED", path: BOOKS },
			{
				type: "INSPECTED",
				path: "/old",
				inspection: inspection({ status: "empty", path: "/old" }),
			},
		]);
		expect(snapshot.step).toMatchObject({
			id: "path",
			path: BOOKS,
			inspection: null,
		});
	});

	it("explains a folder that can't be used and offers the crossover both ways", () => {
		const found = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_CREATE" },
			{ type: "PATH_CHANGED", path: BOOKS },
			{ type: "CONTINUE" },
			{ type: "INSPECTED", path: BOOKS, inspection: library() },
		]);
		expect(found.snapshot.step).toMatchObject({
			id: "path",
			mode: "create",
			checking: false,
		});
		const step = found.snapshot.step;
		if (step.id !== "path") throw new Error("expected the path step");
		expect(verdict("create", step.inspection, false)).toEqual({
			kind: "crossover",
			message: ALREADY_A_LIBRARY_ERROR,
		});
		const switched = run(found, [
			{ type: "SWITCH_MODE" },
			{ type: "CONTINUE" },
		]);
		expect(switched.snapshot.step).toMatchObject({
			id: "confirm",
			mode: "adopt",
			upgrade: true,
		});

		const empty = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_ADOPT" },
			{ type: "PATH_CHANGED", path: BOOKS },
			{ type: "CONTINUE" },
			{
				type: "INSPECTED",
				path: BOOKS,
				inspection: inspection({ status: "empty" }),
			},
		]);
		const emptyStep = empty.snapshot.step;
		if (emptyStep.id !== "path") throw new Error("expected the path step");
		expect(verdict("adopt", emptyStep.inspection, false)).toEqual({
			kind: "crossover",
			message: NOT_A_LIBRARY_ERROR,
		});
		expect(
			verdict(
				"adopt",
				inspection({
					status: "reserved",
					message: "/x is reserved for Citadel's own files",
				}),
				false,
			),
		).toEqual({
			kind: "error",
			message: "/x is reserved for Citadel's own files",
		});
		expect(verdict("adopt", library({ supported: false }), false).kind).toBe(
			"error",
		);
	});

	it("browses folders from the typed path or the browse root and picks one", () => {
		const opened = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_ADOPT" },
			{ type: "OPEN_BROWSER" },
		]);
		expect(opened.effects.at(-1)).toEqual({ kind: "list", path: ROOT });
		expect(opened.snapshot.step).toMatchObject({
			id: "path",
			browser: { path: ROOT, loading: true },
		});
		const listing = {
			path: ROOT,
			parent: "/home",
			entries: [{ name: "books", path: BOOKS, isLibrary: true }],
		};
		const picked = run(opened, [
			{ type: "LISTED", listing },
			{ type: "BROWSE_TO", path: listing.parent },
			{ type: "LIST_FAILED", message: "The server can't read /home" },
			{ type: "PICK", path: BOOKS },
		]);
		expect(picked.effects.slice(-2)).toEqual([
			{ kind: "list", path: "/home" },
			{ kind: "inspect", path: BOOKS },
		]);
		expect(picked.snapshot.step).toMatchObject({
			id: "path",
			path: BOOKS,
			checking: true,
			browser: null,
		});
		const escaped = run(opened, [{ type: "ESCAPE" }]);
		expect(escaped.snapshot.step).toMatchObject({ id: "path", browser: null });
		expect(run(escaped, [{ type: "ESCAPE" }]).snapshot.step).toEqual({
			id: "chooser",
		});
	});

	it("commits adopt with the name and upgrade choice, then reveals the counts", () => {
		const confirmed = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_ADOPT" },
			{ type: "PATH_CHANGED", path: BOOKS },
			{ type: "CONTINUE" },
			{ type: "INSPECTED", path: BOOKS, inspection: library() },
			{ type: "NAME_CHANGED", name: " Phil's Shelf " },
			{ type: "UPGRADE_CHANGED", upgrade: false },
			{ type: "COMMIT" },
		]);
		expect(confirmed.effects.at(-1)).toEqual({
			kind: "commit",
			request: {
				mode: "adopt",
				path: BOOKS,
				name: "Phil's Shelf",
				upgrade: false,
			},
		});
		expect(confirmed.snapshot.step).toMatchObject({
			id: "confirm",
			busy: true,
		});
		const failed = run(confirmed, [
			{
				type: "COMMIT_FAILED",
				message: "This server already serves a library",
			},
		]);
		expect(failed.snapshot.step).toMatchObject({
			id: "confirm",
			busy: false,
			error: "This server already serves a library",
		});
		const done = run(confirmed, [
			{ type: "COMMITTED", library: served() },
			{ type: "SHOW_BOOKS" },
		]);
		expect(done.snapshot.step).toEqual({ id: "done" });
		const revealed = run(confirmed, [{ type: "COMMITTED", library: served() }]);
		expect(revealed.snapshot.step).toEqual({
			id: "reveal",
			books: 1204,
			authors: 300,
		});
	});

	it("creates without a reveal and treats a blank name as the folder's", () => {
		const { snapshot, effects } = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_CREATE" },
			{ type: "PATH_CHANGED", path: BOOKS },
			{ type: "CONTINUE" },
			{
				type: "INSPECTED",
				path: BOOKS,
				inspection: inspection({ status: "empty" }),
			},
			{ type: "NAME_CHANGED", name: "  " },
			{ type: "COMMIT" },
			{ type: "COMMITTED", library: served() },
		]);
		expect(effects.at(-1)).toEqual({
			kind: "commit",
			request: { mode: "create", path: BOOKS, name: null, upgrade: false },
		});
		expect(snapshot.step).toEqual({ id: "done" });
	});

	it("retries an unreachable library and adopts it from where it moved", () => {
		const broken = served({
			available: false,
			problem: "not a Calibre library",
		});
		const retried = run(initSetup(), [loaded(broken), { type: "RETRY" }]);
		expect(retried.effects.at(-1)).toEqual({ kind: "reopen" });
		expect(retried.snapshot.step).toMatchObject({
			id: "broken",
			retry: "checking",
		});
		expect(
			run(retried, [{ type: "REOPENED", library: broken }]).snapshot.step,
		).toMatchObject({ id: "broken", retry: "failed" });
		expect(
			run(retried, [{ type: "REOPENED", library: served() }]).snapshot.step,
		).toEqual({ id: "done" });

		const relocating = run(initSetup(), [
			loaded(broken),
			{ type: "CHOOSE_ADOPT" },
		]);
		expect(relocating.snapshot.step).toMatchObject({
			id: "path",
			mode: "adopt",
			root: "broken",
			path: BOOKS,
		});
		expect(run(relocating, [{ type: "BACK" }]).snapshot.step).toEqual({
			id: "broken",
			library: broken,
			retry: "idle",
		});
	});

	it("goes back from confirm to the path with the inspection kept", () => {
		const { snapshot } = run(initSetup(), [
			loaded(),
			{ type: "CHOOSE_ADOPT" },
			{ type: "PATH_CHANGED", path: BOOKS },
			{ type: "CONTINUE" },
			{ type: "INSPECTED", path: BOOKS, inspection: library() },
			{ type: "BACK" },
		]);
		expect(snapshot.step).toMatchObject({
			id: "path",
			mode: "adopt",
			path: BOOKS,
			inspection: library(),
		});
	});
});
