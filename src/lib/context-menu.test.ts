import { describe, expect, it } from "vitest";
import {
	type ContextMenuEntry,
	matchTypeahead,
	menuItemAria,
	moveHighlight,
	opensMenuFromButton,
	placeMenu,
	pressClosesMenu,
	tidyEntries,
	toggleMenu,
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

describe("menuItemAria", () => {
	const entry = { id: "a", label: "a", onSelect: () => {} };

	it("gives a plain item the menuitem role and no checked state", () => {
		expect(menuItemAria(entry)).toEqual({
			role: "menuitem",
			"aria-checked": undefined,
		});
	});

	it("gives a checked item the menuitemradio role", () => {
		expect(menuItemAria({ ...entry, checked: true })).toEqual({
			role: "menuitemradio",
			"aria-checked": true,
		});
		expect(menuItemAria({ ...entry, checked: false })).toEqual({
			role: "menuitemradio",
			"aria-checked": false,
		});
	});
});

describe("pressClosesMenu", () => {
	const element = (...nodes: unknown[]) => ({
		contains: (node: Node | null) => nodes.includes(node),
	});
	const inMenu = {} as Node;
	const onAnchor = {} as Node;
	const elsewhere = {} as Node;

	it("keeps the menu open for a press on the menu or on its anchor", () => {
		const parts = [element(inMenu), element(onAnchor)];
		expect(pressClosesMenu(inMenu, parts)).toBe(false);
		expect(pressClosesMenu(onAnchor, parts)).toBe(false);
	});

	it("closes the menu for a press anywhere else", () => {
		expect(pressClosesMenu(elsewhere, [element(inMenu), null])).toBe(true);
		expect(pressClosesMenu(null, [element(inMenu)])).toBe(true);
	});
});

describe("opensMenuFromButton", () => {
	it("opens the menu on ArrowDown, Enter and Space", () => {
		expect(["ArrowDown", "Enter", " "].map(opensMenuFromButton)).toEqual([
			true,
			true,
			true,
		]);
	});

	it("leaves the other keys to the page", () => {
		expect(["ArrowUp", "Escape", "Tab", "a"].map(opensMenuFromButton)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});
});

describe("toggleMenu", () => {
	const button = {} as HTMLElement;
	const otherButton = {} as HTMLElement;
	const under = (anchor: HTMLElement) => ({
		x: 40,
		y: 72,
		items: ENTRIES,
		label: "Search scope",
		anchor,
	});

	it("opens the menu of the button when no menu is open", () => {
		expect(toggleMenu(null, under(button))).toEqual(under(button));
	});

	it("closes the menu on a second click of its button", () => {
		expect(toggleMenu(under(button), under(button))).toBeNull();
	});

	it("opens the menu of the button over a menu from another place", () => {
		const contextMenu = { x: 5, y: 5, items: ENTRIES };
		expect(toggleMenu(under(otherButton), under(button))).toEqual(
			under(button),
		);
		expect(toggleMenu(contextMenu, under(button))).toEqual(under(button));
	});
});
