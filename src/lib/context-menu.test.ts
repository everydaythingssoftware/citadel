import { describe, expect, it } from "vitest";
import {
	type ContextMenuEntry,
	matchTypeahead,
	moveHighlight,
	placeMenu,
	tidyEntries,
} from "./context-menu";

const item = (id: string, extra: Partial<ContextMenuEntry> = {}) =>
	({ id, label: id, onSelect: () => {}, ...extra }) as ContextMenuEntry;
const separator = (id: string): ContextMenuEntry => ({
	type: "separator",
	id,
});

// Show Details · ─ · Read (disabled) · Rename · ─ · Delete
const ENTRIES: ContextMenuEntry[] = [
	item("Show Details"),
	separator("s1"),
	item("Read", { disabled: true }),
	item("Rename"),
	separator("s2"),
	item("Delete", { destructive: true }),
];

describe("moveHighlight", () => {
	it("starts at the first or last enabled item", () => {
		expect(moveHighlight(ENTRIES, null, "next")).toBe(0);
		expect(moveHighlight(ENTRIES, null, "previous")).toBe(5);
		expect(moveHighlight(ENTRIES, 3, "first")).toBe(0);
		expect(moveHighlight(ENTRIES, 0, "last")).toBe(5);
	});

	it("skips separators and disabled items, and wraps", () => {
		expect(moveHighlight(ENTRIES, 0, "next")).toBe(3);
		expect(moveHighlight(ENTRIES, 3, "next")).toBe(5);
		expect(moveHighlight(ENTRIES, 5, "next")).toBe(0);
		expect(moveHighlight(ENTRIES, 0, "previous")).toBe(5);
		expect(moveHighlight(ENTRIES, 3, "previous")).toBe(0);
	});

	it("finds nothing in a menu with nothing enabled", () => {
		expect(moveHighlight([], null, "next")).toBeNull();
		expect(
			moveHighlight([item("A", { disabled: true })], null, "first"),
		).toBeNull();
	});
});

describe("matchTypeahead", () => {
	it("jumps to the first enabled item starting with the typed text", () => {
		expect(matchTypeahead(ENTRIES, "d", null)).toBe(5);
		expect(matchTypeahead(ENTRIES, "sh", null)).toBe(0);
		expect(matchTypeahead(ENTRIES, "re", null)).toBe(3);
		expect(matchTypeahead(ENTRIES, "x", null)).toBeNull();
	});

	it("steps through items sharing a letter when it is repeated", () => {
		const entries = [item("Read"), item("Rename"), item("Reveal")];
		expect(matchTypeahead(entries, "r", null)).toBe(0);
		expect(matchTypeahead(entries, "r", 0)).toBe(1);
		expect(matchTypeahead(entries, "rr", 1)).toBe(2);
		expect(matchTypeahead(entries, "rr", 2)).toBe(0);
		expect(matchTypeahead(entries, "rev", 0)).toBe(2);
	});
});

describe("tidyEntries", () => {
	it("drops leading, trailing and doubled separators", () => {
		const tidy = tidyEntries([
			separator("a"),
			item("One"),
			separator("b"),
			separator("c"),
			item("Two"),
			separator("d"),
		]);
		expect(tidy.map((entry) => entry.id)).toEqual(["One", "b", "Two"]);
	});
});

describe("placeMenu", () => {
	const viewport = { viewportWidth: 800, viewportHeight: 600 };

	it("opens at the pointer when it fits", () => {
		expect(
			placeMenu({ x: 100, y: 100, width: 200, height: 150, ...viewport }),
		).toEqual({ left: 100, top: 100 });
	});

	it("flips left of the pointer near the right edge", () => {
		expect(
			placeMenu({ x: 700, y: 100, width: 200, height: 150, ...viewport }),
		).toEqual({ left: 500, top: 100 });
	});

	it("slides up near the bottom and stays inside the margin", () => {
		expect(
			placeMenu({ x: 100, y: 550, width: 200, height: 150, ...viewport }),
		).toEqual({ left: 100, top: 442 });
		expect(
			placeMenu({ x: 4, y: 4, width: 900, height: 900, ...viewport }),
		).toEqual({ left: 8, top: 8 });
	});
});
