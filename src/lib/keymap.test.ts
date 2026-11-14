import { describe, expect, it, vi } from "vitest";
import type { KeymapDispatchEventLike } from "./keymap";
import {
	NO_SELECTION,
	createKeymapHandler,
	eventMatchesChord,
	isEditableTarget,
	moveSelection,
	parseChord,
} from "./keymap";

const makeEvent = (
	overrides: Partial<KeymapDispatchEventLike> = {},
): KeymapDispatchEventLike => ({
	key: "",
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	...overrides,
});

describe("parseChord", () => {
	it("parses a bare key with no modifiers", () => {
		expect(parseChord("escape")).toEqual({
			key: "escape",
			mod: false,
			shift: false,
			alt: false,
		});
	});

	it("parses mod chords", () => {
		expect(parseChord("mod+f")).toEqual({
			key: "f",
			mod: true,
			shift: false,
			alt: false,
		});
	});

	it("parses multiple modifiers", () => {
		expect(parseChord("mod+shift+alt+k")).toEqual({
			key: "k",
			mod: true,
			shift: true,
			alt: true,
		});
	});

	it("is case-insensitive", () => {
		expect(parseChord("Mod+F")).toEqual({
			key: "f",
			mod: true,
			shift: false,
			alt: false,
		});
	});

	it("parses digit and arrow chords", () => {
		expect(parseChord("mod+1").key).toBe("1");
		expect(parseChord("arrowdown").key).toBe("arrowdown");
	});
});

describe("eventMatchesChord", () => {
	it("matches a bare key only when no modifiers are held", () => {
		expect(eventMatchesChord(makeEvent({ key: "f" }), "f")).toBe(true);
		expect(eventMatchesChord(makeEvent({ key: "f", metaKey: true }), "f")).toBe(
			false,
		);
		expect(eventMatchesChord(makeEvent({ key: "f", ctrlKey: true }), "f")).toBe(
			false,
		);
		expect(
			eventMatchesChord(makeEvent({ key: "f", shiftKey: true }), "f"),
		).toBe(false);
		expect(eventMatchesChord(makeEvent({ key: "f", altKey: true }), "f")).toBe(
			false,
		);
	});

	it("treats mod as meta OR ctrl", () => {
		expect(
			eventMatchesChord(makeEvent({ key: "f", metaKey: true }), "mod+f"),
		).toBe(true);
		expect(
			eventMatchesChord(makeEvent({ key: "f", ctrlKey: true }), "mod+f"),
		).toBe(true);
		expect(eventMatchesChord(makeEvent({ key: "f" }), "mod+f")).toBe(false);
	});

	it("requires exact modifiers", () => {
		expect(
			eventMatchesChord(
				makeEvent({ key: "f", metaKey: true, shiftKey: true }),
				"mod+f",
			),
		).toBe(false);
		expect(
			eventMatchesChord(
				makeEvent({ key: "f", metaKey: true, altKey: true }),
				"mod+f",
			),
		).toBe(false);
		expect(
			eventMatchesChord(
				makeEvent({ key: "f", metaKey: true, shiftKey: true }),
				"mod+shift+f",
			),
		).toBe(true);
	});

	it("compares keys case-insensitively", () => {
		expect(eventMatchesChord(makeEvent({ key: "Escape" }), "escape")).toBe(
			true,
		);
		expect(
			eventMatchesChord(makeEvent({ key: "ArrowDown" }), "arrowdown"),
		).toBe(true);
	});

	it("names the space bar “space”", () => {
		expect(eventMatchesChord(makeEvent({ key: " " }), "space")).toBe(true);
		expect(
			eventMatchesChord(makeEvent({ key: " ", shiftKey: true }), "space"),
		).toBe(false);
	});

	it("matches shifted letters and arrows", () => {
		expect(
			eventMatchesChord(makeEvent({ key: "A", metaKey: true }), "mod+a"),
		).toBe(true);
		expect(
			eventMatchesChord(
				makeEvent({ key: "ArrowLeft", shiftKey: true }),
				"shift+arrowleft",
			),
		).toBe(true);
	});

	it("does not match a different key", () => {
		expect(
			eventMatchesChord(makeEvent({ key: "g", metaKey: true }), "mod+f"),
		).toBe(false);
	});
});

describe("isEditableTarget", () => {
	it("is false for null and undefined", () => {
		expect(isEditableTarget(null)).toBe(false);
		expect(isEditableTarget(undefined)).toBe(false);
	});

	it("is true for input, textarea, and select elements", () => {
		expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
		expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
		expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
	});

	it("ignores tag name casing", () => {
		expect(isEditableTarget({ tagName: "input" })).toBe(true);
	});

	it("is true for contenteditable elements", () => {
		expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
			true,
		);
	});

	it("is false for inputs that take no typing", () => {
		expect(isEditableTarget({ tagName: "INPUT", type: "checkbox" })).toBe(
			false,
		);
		expect(isEditableTarget({ tagName: "INPUT", type: "Radio" })).toBe(false);
		expect(isEditableTarget({ tagName: "INPUT", type: "search" })).toBe(true);
		expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
	});

	it("is false for ordinary elements", () => {
		expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
		expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
		expect(isEditableTarget({})).toBe(false);
	});
});

describe("createKeymapHandler", () => {
	it("calls the first matching binding, prevents default, and reports handled", () => {
		const onMatch = vi.fn();
		const preventDefault = vi.fn();
		const handler = createKeymapHandler([{ chord: "mod+f", onMatch }]);

		const handled = handler(
			makeEvent({ key: "f", metaKey: true, preventDefault }),
		);

		expect(handled).toBe(true);
		expect(onMatch).toHaveBeenCalledTimes(1);
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	it("reports unhandled and leaves default behavior when nothing matches", () => {
		const onMatch = vi.fn();
		const preventDefault = vi.fn();
		const handler = createKeymapHandler([{ chord: "mod+f", onMatch }]);

		const handled = handler(makeEvent({ key: "g", preventDefault }));

		expect(handled).toBe(false);
		expect(onMatch).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it("only dispatches the first of two matching bindings", () => {
		const first = vi.fn();
		const second = vi.fn();
		const handler = createKeymapHandler([
			{ chord: "enter", onMatch: first },
			{ chord: "enter", onMatch: second },
		]);

		handler(makeEvent({ key: "Enter" }));

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
	});

	it("skips bindings without allowInEditable when the target is editable", () => {
		const onMatch = vi.fn();
		const handler = createKeymapHandler([{ chord: "arrowdown", onMatch }]);

		const handled = handler(
			makeEvent({ key: "ArrowDown", target: { tagName: "INPUT" } }),
		);

		expect(handled).toBe(false);
		expect(onMatch).not.toHaveBeenCalled();
	});

	it("dispatches allowInEditable bindings when the target is editable", () => {
		const onMatch = vi.fn();
		const handler = createKeymapHandler([
			{ chord: "mod+f", allowInEditable: true, onMatch },
		]);

		const handled = handler(
			makeEvent({ key: "f", metaKey: true, target: { tagName: "INPUT" } }),
		);

		expect(handled).toBe(true);
		expect(onMatch).toHaveBeenCalledTimes(1);
	});

	it("skips a matching binding whose when predicate returns false", () => {
		const onMatch = vi.fn();
		const preventDefault = vi.fn();
		const handler = createKeymapHandler([
			{ chord: "escape", when: () => false, onMatch },
		]);

		const handled = handler(makeEvent({ key: "Escape", preventDefault }));

		expect(handled).toBe(false);
		expect(onMatch).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it("falls past a when-skipped binding to a later matching binding", () => {
		const skipped = vi.fn();
		const allowed = vi.fn();
		const handler = createKeymapHandler([
			{ chord: "escape", when: () => false, onMatch: skipped },
			{ chord: "escape", onMatch: allowed },
		]);

		handler(makeEvent({ key: "Escape" }));

		expect(skipped).not.toHaveBeenCalled();
		expect(allowed).toHaveBeenCalledTimes(1);
	});

	it("dispatches normally when the when predicate returns true", () => {
		const onMatch = vi.fn();
		const preventDefault = vi.fn();
		const handler = createKeymapHandler([
			{ chord: "escape", when: () => true, onMatch },
		]);

		const handled = handler(makeEvent({ key: "Escape", preventDefault }));

		expect(handled).toBe(true);
		expect(onMatch).toHaveBeenCalledTimes(1);
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	it("falls past editable-skipped bindings to a later allowInEditable match", () => {
		const skipped = vi.fn();
		const allowed = vi.fn();
		const handler = createKeymapHandler([
			{ chord: "escape", onMatch: skipped },
			{ chord: "escape", allowInEditable: true, onMatch: allowed },
		]);

		handler(makeEvent({ key: "Escape", target: { tagName: "TEXTAREA" } }));

		expect(skipped).not.toHaveBeenCalled();
		expect(allowed).toHaveBeenCalledTimes(1);
	});
});

describe("moveSelection", () => {
	it("returns no selection for an empty list", () => {
		for (const direction of ["up", "down", "left", "right"] as const) {
			expect(
				moveSelection({ index: -1, count: 0, columns: 5, direction }),
			).toBe(NO_SELECTION);
			expect(moveSelection({ index: 3, count: 0, columns: 5, direction })).toBe(
				NO_SELECTION,
			);
		}
	});

	it("selects the first book on down/right when nothing is selected", () => {
		expect(
			moveSelection({ index: -1, count: 10, columns: 5, direction: "down" }),
		).toBe(0);
		expect(
			moveSelection({ index: -1, count: 10, columns: 5, direction: "right" }),
		).toBe(0);
	});

	it("keeps no selection on up/left when nothing is selected", () => {
		expect(
			moveSelection({ index: -1, count: 10, columns: 5, direction: "up" }),
		).toBe(NO_SELECTION);
		expect(
			moveSelection({ index: -1, count: 10, columns: 5, direction: "left" }),
		).toBe(NO_SELECTION);
	});

	it("moves right by one and clamps at the last item", () => {
		expect(
			moveSelection({ index: 0, count: 5, columns: 5, direction: "right" }),
		).toBe(1);
		expect(
			moveSelection({ index: 4, count: 5, columns: 5, direction: "right" }),
		).toBe(4);
	});

	it("moves left by one and clamps at the first item", () => {
		expect(
			moveSelection({ index: 3, count: 5, columns: 5, direction: "left" }),
		).toBe(2);
		expect(
			moveSelection({ index: 0, count: 5, columns: 5, direction: "left" }),
		).toBe(0);
	});

	it("moves down by one row", () => {
		expect(
			moveSelection({ index: 1, count: 12, columns: 5, direction: "down" }),
		).toBe(6);
	});

	it("moves up by one row and blocks at the first row", () => {
		expect(
			moveSelection({ index: 6, count: 12, columns: 5, direction: "up" }),
		).toBe(1);
		expect(
			moveSelection({ index: 3, count: 12, columns: 5, direction: "up" }),
		).toBe(3);
	});

	it("clamps down into a partial last row", () => {
		expect(
			moveSelection({ index: 8, count: 12, columns: 5, direction: "down" }),
		).toBe(11);
	});

	it("blocks down from the last row", () => {
		expect(
			moveSelection({ index: 10, count: 12, columns: 5, direction: "down" }),
		).toBe(10);
		expect(
			moveSelection({ index: 11, count: 12, columns: 5, direction: "down" }),
		).toBe(11);
	});

	it("treats a single column list as vertical-only movement", () => {
		expect(
			moveSelection({ index: 0, count: 3, columns: 1, direction: "down" }),
		).toBe(1);
		expect(
			moveSelection({ index: 2, count: 3, columns: 1, direction: "down" }),
		).toBe(2);
		expect(
			moveSelection({ index: 1, count: 3, columns: 1, direction: "up" }),
		).toBe(0);
		expect(
			moveSelection({ index: 0, count: 3, columns: 1, direction: "up" }),
		).toBe(0);
		expect(
			moveSelection({ index: 1, count: 3, columns: 1, direction: "right" }),
		).toBe(2);
		expect(
			moveSelection({ index: 1, count: 3, columns: 1, direction: "left" }),
		).toBe(0);
	});
});
