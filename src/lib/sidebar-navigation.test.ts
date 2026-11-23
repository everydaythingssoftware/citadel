import { describe, expect, it } from "vitest";
import {
	activeSidebarPosition,
	continuesHintHold,
	endsHintHold,
	startsHintHold,
	stepSidebarPosition,
} from "./sidebar-navigation";

describe("activeSidebarPosition", () => {
	it("finds the section showing, a book counting as All Books, an open shelf after the sections", () => {
		const at = (pathname: string, activeShelfIndex = -1) =>
			activeSidebarPosition({ pathname, activeShelfIndex });
		expect(at("/")).toBe(0);
		expect(at("/books/12")).toBe(0);
		expect(at("/tags")).toBe(3);
		expect(at("/settings")).toBe(-1);
		expect(at("/", 1)).toBe(6);
	});
});

describe("stepSidebarPosition", () => {
	it("steps through the items, wraps at both ends, and starts at an end when nothing is showing", () => {
		expect(stepSidebarPosition(2, 7, 1)).toBe(3);
		expect(stepSidebarPosition(6, 7, 1)).toBe(0);
		expect(stepSidebarPosition(0, 7, -1)).toBe(6);
		expect(stepSidebarPosition(-1, 7, 1)).toBe(0);
		expect(stepSidebarPosition(-1, 7, -1)).toBe(6);
	});
});

describe("hint hold", () => {
	const press = (overrides: Partial<Parameters<typeof startsHintHold>[0]>) => ({
		key: "Control",
		repeat: false,
		ctrlKey: true,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	});

	it("starts on the modifier alone, outside a field", () => {
		expect(startsHintHold(press({}), "Control")).toBe(true);
		expect(
			startsHintHold(
				press({ key: "Meta", ctrlKey: false, metaKey: true }),
				"Meta",
			),
		).toBe(true);
		expect(startsHintHold(press({}), "Meta")).toBe(false);
	});

	it("doesn't start with another modifier held, in a field, or on a repeat", () => {
		expect(startsHintHold(press({ shiftKey: true }), "Control")).toBe(false);
		expect(startsHintHold(press({ metaKey: true }), "Control")).toBe(false);
		expect(
			startsHintHold(
				press({ target: { tagName: "INPUT", type: "text" } }),
				"Control",
			),
		).toBe(false);
		expect(startsHintHold(press({ repeat: true }), "Control")).toBe(false);
		expect(continuesHintHold(press({ repeat: true }), "Control")).toBe(true);
	});

	it("goes on across the chords that walk the sidebar", () => {
		const held = (overrides: Parameters<typeof press>[0]) =>
			continuesHintHold(press(overrides), "Control");
		expect(held({ key: "PageDown" })).toBe(true);
		expect(held({ key: "PageUp" })).toBe(true);
		expect(held({ key: "Tab" })).toBe(true);
		expect(held({ key: "Shift", shiftKey: true })).toBe(true);
		expect(held({ key: "Tab", shiftKey: true })).toBe(true);
		expect(held({ key: "&", code: "Digit1" })).toBe(true);
		expect(
			continuesHintHold(
				press({ key: "2", code: "Digit2", ctrlKey: false, metaKey: true }),
				"Meta",
			),
		).toBe(true);
	});

	it("ends on any other chord", () => {
		const held = (overrides: Parameters<typeof press>[0]) =>
			continuesHintHold(press(overrides), "Control");
		expect(held({ key: "c", code: "KeyC" })).toBe(false);
		expect(held({ key: "f", code: "KeyF" })).toBe(false);
		expect(held({ key: "PageDown", shiftKey: true })).toBe(false);
		expect(held({ key: "PageDown", altKey: true })).toBe(false);
		expect(held({ key: "PageDown", ctrlKey: false })).toBe(false);
		expect(held({ key: "0", code: "Digit0" })).toBe(false);
		expect(
			continuesHintHold(
				press({ key: "Tab", ctrlKey: false, metaKey: true }),
				"Meta",
			),
		).toBe(false);
	});

	it("ends on the modifier's release, not a walking key's", () => {
		const up = (key: string, ctrlKey: boolean) =>
			endsHintHold({ key, ctrlKey, metaKey: false, altKey: false }, "Control");
		expect(up("PageDown", true)).toBe(false);
		expect(up("Shift", true)).toBe(false);
		expect(up("Control", false)).toBe(true);
		expect(up("PageDown", false)).toBe(true);
	});
});
