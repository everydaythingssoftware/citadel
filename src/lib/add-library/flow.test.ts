import { describe, expect, it } from "vitest";
import type { AddLibraryEvent, AddLibraryStep } from "./flow";
import {
	folderName,
	folderNameProblem,
	initialAddLibraryStep,
	joinFolder,
	transition,
} from "./flow";

const BOOKS = "/Users/reader/Documents/Books";
const DOCUMENTS = "/Users/reader/Documents";
const INSIDE = "/Users/reader/Documents/Calibre Library";

const run = (events: AddLibraryEvent[], from = initialAddLibraryStep) =>
	events.reduce<{ step: AddLibraryStep; effects: unknown[] }>(
		({ step, effects }, event) => {
			const next = transition(step, event);
			return { step: next.step, effects: [...effects, ...next.effects] };
		},
		{ step: from, effects: [] },
	);

const pickAndInspect = (folder: string): AddLibraryEvent[] => [
	{ type: "START" },
	{ type: "PICKED", path: folder },
];

describe("add-library flow", () => {
	it("opens the picker, and returns to idle when it is cancelled", () => {
		const started = transition(initialAddLibraryStep, { type: "START" });
		expect(started.step.id).toBe("picking");
		expect(started.effects).toEqual([{ type: "pick" }]);
		expect(
			transition(started.step, { type: "PICKED", path: null }).step,
		).toEqual(initialAddLibraryStep);
	});

	it("adds a picked library straight away, with no question", () => {
		const { step, effects } = run([
			...pickAndInspect(BOOKS),
			{ type: "INSPECTED", contents: { kind: "library" } },
		]);
		expect(step).toEqual({ id: "adding", folder: BOOKS });
		expect(effects).toContainEqual({ type: "adopt", path: BOOKS });
		expect(transition(step, { type: "SUCCEEDED" }).step.id).toBe("idle");
	});

	it("offers the library one folder down, with its book count", () => {
		const { step, effects } = run([
			...pickAndInspect(DOCUMENTS),
			{
				type: "INSPECTED",
				contents: {
					kind: "libraryInside",
					library_path: INSIDE,
					suggested_name: "Calibre Library 2",
				},
			},
			{ type: "BOOK_COUNT", libraryPath: INSIDE, count: 1204 },
		]);
		expect(step).toMatchObject({
			id: "open-inside",
			libraryPath: INSIDE,
			bookCount: 1204,
		});
		expect(effects).toContainEqual({
			type: "count-books",
			libraryPath: INSIDE,
		});
		const confirmed = transition(step, { type: "CONFIRM" });
		expect(confirmed.effects).toEqual([{ type: "adopt", path: INSIDE }]);
		expect(confirmed.step).toMatchObject({ busy: true });
	});

	it("switches from the found library to creating one beside it", () => {
		const { step } = run([
			...pickAndInspect(DOCUMENTS),
			{
				type: "INSPECTED",
				contents: {
					kind: "libraryInside",
					library_path: INSIDE,
					suggested_name: "Calibre Library 2",
				},
			},
			{ type: "CREATE_INSTEAD" },
		]);
		expect(step).toEqual({
			id: "create-inside",
			folder: DOCUMENTS,
			name: "Calibre Library 2",
			busy: false,
			error: null,
		});
	});

	it("creates in an empty folder itself", () => {
		const { step } = run([
			...pickAndInspect(BOOKS),
			{ type: "INSPECTED", contents: { kind: "empty" } },
		]);
		expect(step.id).toBe("create-here");
		expect(transition(step, { type: "CONFIRM" }).effects).toEqual([
			{ type: "create", path: BOOKS },
		]);
	});

	it("creates in a named folder inside one that has other files", () => {
		const { step } = run([
			...pickAndInspect(BOOKS),
			{
				type: "INSPECTED",
				contents: { kind: "otherFiles", suggested_name: "Calibre Library" },
			},
			{ type: "NAME_CHANGED", name: "  Kids’ Books " },
		]);
		expect(transition(step, { type: "CONFIRM" }).effects).toEqual([
			{ type: "create", path: `${BOOKS}/Kids’ Books` },
		]);
	});

	it("keeps an unusable name on the dialog instead of creating", () => {
		const { step } = run([
			...pickAndInspect(BOOKS),
			{
				type: "INSPECTED",
				contents: { kind: "otherFiles", suggested_name: "Calibre Library" },
			},
			{ type: "NAME_CHANGED", name: "a/b" },
			{ type: "CONFIRM" },
		]);
		expect(step).toMatchObject({ id: "create-inside", busy: false });
		expect(step).toHaveProperty(
			"error",
			"Folder names can’t contain / \\ or :.",
		);
	});

	it("explains a taken name gently and lets the user try another", () => {
		const { step } = run([
			...pickAndInspect(BOOKS),
			{
				type: "INSPECTED",
				contents: { kind: "otherFiles", suggested_name: "Calibre Library" },
			},
			{ type: "CONFIRM" },
			{
				type: "FAILED",
				message: "create-library/folder-not-empty",
				code: "folder-not-empty",
			},
		]);
		expect(step).toMatchObject({
			id: "create-inside",
			busy: false,
			error:
				"“Books” already has something called “Calibre Library”. Try another name.",
		});
		expect(
			transition(step, { type: "NAME_CHANGED", name: "Other" }).step,
		).toHaveProperty("error", null);
	});

	it("goes back to the picker to choose another folder", () => {
		const { step, effects } = run([
			...pickAndInspect(BOOKS),
			{
				type: "INSPECTED",
				contents: { kind: "otherFiles", suggested_name: "Calibre Library" },
			},
			{ type: "CHOOSE_ANOTHER" },
		]);
		expect(step.id).toBe("picking");
		expect(
			effects.filter((e) => (e as { type: string }).type === "pick"),
		).toHaveLength(2);
	});

	it("ignores Cancel while creating", () => {
		const { step } = run([
			...pickAndInspect(BOOKS),
			{ type: "INSPECTED", contents: { kind: "empty" } },
			{ type: "CONFIRM" },
			{ type: "CANCEL" },
		]);
		expect(step).toMatchObject({ id: "create-here", busy: true });
	});

	it("reports an unreadable folder without leaving a dialog open", () => {
		const { step, effects } = run([
			...pickAndInspect(BOOKS),
			{ type: "INSPECT_FAILED", message: "Permission denied" },
		]);
		expect(step.id).toBe("idle");
		expect(effects).toContainEqual({
			type: "notify-failure",
			title: "Couldn’t read that folder",
			message: "Permission denied",
		});
	});
});

describe("folder helpers", () => {
	it("names a folder by its last path segment", () => {
		expect(folderName("/Users/reader/Books/")).toBe("Books");
		expect(folderName("C:\\Users\\reader\\Books")).toBe("Books");
	});

	it("joins with the folder's own separator", () => {
		expect(joinFolder("/a/b/", "New")).toBe("/a/b/New");
		expect(joinFolder("C:\\a\\b", "New")).toBe("C:\\a\\b\\New");
	});

	it("rejects empty and path-like names", () => {
		expect(folderNameProblem("  ")).toBe("Enter a name for the folder.");
		expect(folderNameProblem("..")).toBe("Choose a different name.");
		expect(folderNameProblem("Calibre Library")).toBeNull();
	});
});
