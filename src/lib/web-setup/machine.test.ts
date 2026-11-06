import { describe, expect, it } from "vitest";
import type {
	PathInspection,
	ServedLibrary,
} from "@/lib/services/library-catalog/types";
import type {
	PublicUrls,
	SetupEffect,
	SetupEvent,
	SetupSnapshot,
	TransitionResult,
} from "./machine";
import type { FoundLibraries } from "@/lib/services/library-catalog/types";
import {
	ALREADY_A_LIBRARY_ERROR,
	EMPTY_PATH_ERROR,
	initSetup,
	isLocalAddress,
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
	readOnlyChosen: false,
	readOnlyReason: null,
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
			writable: true,
			readOnlyReason: null,
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

const loaded = (
	library: ServedLibrary | null = null,
	found: FoundLibraries = { libraries: [], createIn: [] },
	publicUrls: PublicUrls | null = null,
): SetupEvent => ({
	type: "STATUS_LOADED",
	library,
	browseRoot: ROOT,
	found,
	publicUrls,
});

const urls = (patch: Partial<PublicUrls> = {}): PublicUrls => ({
	listed: [],
	current: "http://nas.local:8081",
	configFile: null,
	...patch,
});

describe("web setup machine", () => {
	it("loads the status first and lands on the chooser when nothing is served", () => {
		const start = initSetup();
		expect(start.effects).toEqual([{ kind: "load-status" }]);
		const { snapshot } = run(start, [loaded()]);
		expect(snapshot.step).toEqual({ id: "chooser" });
		expect(snapshot.browseRoot).toBe(ROOT);
	});

	it("shows the public URLs first on a fresh setup, and can be skipped", () => {
		const shown = run(initSetup(), [loaded(null, undefined, urls())]);
		expect(shown.snapshot.step).toEqual({
			id: "address",
			urls: urls(),
			typed: "",
			checking: false,
			stillMissing: false,
			error: null,
			next: { id: "chooser" },
		});
		expect(transition(shown.snapshot, { type: "BACK" }).snapshot).toBe(
			shown.snapshot,
		);
		expect(
			transition(shown.snapshot, { type: "ADDRESS_DONE" }).snapshot.step,
		).toEqual({ id: "chooser" });
		// Without the server's answer, or once a library exists, there's no step.
		expect(run(initSetup(), [loaded()]).snapshot.step).toEqual({
			id: "chooser",
		});
		expect(
			run(initSetup(), [loaded(served(), undefined, urls())]).snapshot.step,
		).toEqual({ id: "done" });
	});

	it("continues by asking the server again, until it has a public URL", () => {
		const shown = run(initSetup(), [loaded(null, undefined, urls())]).snapshot;
		const checking = transition(shown, { type: "ADDRESS_CHECK" });
		expect(checking.effects).toEqual([{ kind: "load-addresses" }]);
		expect(
			transition(checking.snapshot, { type: "ADDRESS_CHECK" }).effects,
		).toEqual([]);
		expect(
			transition(checking.snapshot, { type: "ADDRESS_DONE" }).snapshot,
		).toBe(checking.snapshot);

		const missing = transition(checking.snapshot, {
			type: "ADDRESSES_LOADED",
			urls: urls(),
		}).snapshot;
		expect(missing.step).toMatchObject({ checking: false, stillMissing: true });
		const typed = transition(missing, {
			type: "ADDRESS_TYPED",
			url: "https://books.example.com",
		}).snapshot;
		expect(typed.step).toMatchObject({
			typed: "https://books.example.com",
			stillMissing: false,
		});

		const unreachable = transition(checking.snapshot, {
			type: "ADDRESSES_FAILED",
			message: "Couldn’t reach the server.",
		}).snapshot;
		expect(unreachable.step).toMatchObject({
			checking: false,
			error: "Couldn’t reach the server.",
		});

		const configured = urls({ listed: ["http://nas.local:8081"] });
		const found = transition(checking.snapshot, {
			type: "ADDRESSES_LOADED",
			urls: configured,
		}).snapshot;
		expect(found.step).toMatchObject({ urls: configured, stillMissing: false });
		expect(transition(found, { type: "ADDRESS_DONE" }).snapshot.step).toEqual({
			id: "chooser",
		});
	});

	it("knows this machine's own names", () => {
		for (const local of [
			"http://localhost:8081",
			"http://books.localhost:8081",
			"http://127.0.0.1:8081",
			"http://[::1]:8081",
		])
			expect(isLocalAddress(local), local).toBe(true);
		for (const other of [
			"http://nas.local:8081",
			"https://books.example.com",
			"nonsense",
		])
			expect(isLocalAddress(other), other).toBe(false);
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
				readOnly: false,
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
			request: {
				mode: "create",
				path: BOOKS,
				name: null,
				upgrade: false,
				readOnly: false,
			},
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

	describe("libraries found in the mounted folders", () => {
		const MOUNT = "/library";
		const mounted = library({ upgradeAvailable: false });
		const foundHere = { ...mounted, path: MOUNT, name: "library" };
		const emptyMount = inspection({
			status: "empty",
			path: "/libraries",
			name: "libraries",
		});
		const found: FoundLibraries = {
			libraries: [foundHere],
			createIn: [emptyMount],
		};

		it("opens a found library in one step, and Back returns to the chooser", () => {
			const { snapshot } = run(initSetup(), [
				loaded(null, found),
				{ type: "USE_FOUND", path: MOUNT },
			]);
			expect(snapshot.found).toEqual(found);
			expect(snapshot.step).toMatchObject({
				id: "confirm",
				mode: "adopt",
				path: MOUNT,
				name: "library",
				readOnly: false,
				fromChooser: true,
			});
			const back = transition(snapshot, { type: "BACK" });
			expect(back.snapshot.step).toEqual({ id: "chooser" });
		});

		it("starts a new library in an empty mount", () => {
			const { snapshot } = run(initSetup(), [
				loaded(null, found),
				{ type: "CREATE_IN", path: "/libraries" },
			]);
			expect(snapshot.step).toMatchObject({
				id: "confirm",
				mode: "create",
				path: "/libraries",
				fromChooser: true,
			});
		});

		it("ignores paths it wasn't offered", () => {
			const { snapshot } = run(initSetup(), [
				loaded(null, found),
				{ type: "CREATE_IN", path: "/elsewhere" },
			]);
			expect(snapshot.step).toEqual({ id: "chooser" });
		});
	});

	describe("read-only", () => {
		const reachConfirm = (target = library()) =>
			run(initSetup(), [
				loaded(),
				{ type: "CHOOSE_ADOPT" },
				{ type: "PATH_CHANGED", path: BOOKS },
				{ type: "CONTINUE" },
				{ type: "INSPECTED", path: BOOKS, inspection: target },
			]);

		it("can be chosen, and takes the upgrade with it", () => {
			const confirmed = reachConfirm();
			expect(confirmed.snapshot.step).toMatchObject({
				readOnly: false,
				upgrade: true,
			});
			const chosen = run(confirmed, [
				{ type: "READ_ONLY_CHANGED", readOnly: true },
				{ type: "UPGRADE_CHANGED", upgrade: true },
				{ type: "COMMIT" },
			]);
			expect(chosen.snapshot.step).toMatchObject({
				readOnly: true,
				upgrade: false,
			});
			expect(chosen.effects.at(-1)).toEqual({
				kind: "commit",
				request: {
					mode: "adopt",
					path: BOOKS,
					name: "books",
					upgrade: false,
					readOnly: true,
				},
			});
			const undone = run(confirmed, [
				{ type: "READ_ONLY_CHANGED", readOnly: true },
				{ type: "READ_ONLY_CHANGED", readOnly: false },
			]);
			expect(undone.snapshot.step).toMatchObject({
				readOnly: false,
				upgrade: true,
			});
		});

		it("is forced on when the server can't write the library", () => {
			const unwritable = library({
				writable: false,
				readOnlyReason: "/srv/books is mounted read-only.",
			});
			const confirmed = run(reachConfirm(unwritable), [
				{ type: "READ_ONLY_CHANGED", readOnly: false },
			]);
			expect(confirmed.snapshot.step).toMatchObject({
				readOnly: true,
				upgrade: false,
			});
		});
	});
});
