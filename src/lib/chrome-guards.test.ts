import { describe, expect, it } from "vitest";
import {
	allowsBrowserContextMenu,
	allowsDragStart,
	allowsNativeSelectAll,
	type GuardTarget,
	selectableFromStyles,
} from "./chrome-guards";

describe("selectableFromStyles", () => {
	it("lets the nearest decisive user-select win", () => {
		expect(selectableFromStyles(["auto", "text", "none"])).toBe(true);
		expect(selectableFromStyles(["auto", "none", "text"])).toBe(false);
		expect(selectableFromStyles(["all"])).toBe(true);
		expect(selectableFromStyles(["auto", "auto"])).toBe(false);
	});

	it("opens the browser menu over CSS-selectable text with a selection", () => {
		expect(allowsBrowserContextMenu(inside(), "Dune", true)).toBe(true);
		expect(allowsBrowserContextMenu(inside(), "", true)).toBe(false);
	});
});

/** A target inside elements matching these selector fragments. */
const inside = (...fragments: string[]): GuardTarget => ({
	closest: (selector) =>
		fragments.some((fragment) => selector.includes(fragment)) ? {} : null,
});

const CHROME = inside();

describe("allowsBrowserContextMenu", () => {
	it("blocks the browser menu over chrome and images", () => {
		expect(allowsBrowserContextMenu(CHROME, "")).toBe(false);
		expect(allowsBrowserContextMenu(inside("img"), "")).toBe(false);
		expect(allowsBrowserContextMenu(null, "")).toBe(false);
	});

	it("keeps it in text fields and editable text", () => {
		expect(allowsBrowserContextMenu(inside("textarea"), "")).toBe(true);
		expect(allowsBrowserContextMenu(inside("[contenteditable]"), "")).toBe(
			true,
		);
		expect(allowsBrowserContextMenu(inside("[type='search']"), "")).toBe(true);
	});

	it("keeps it over selectable content only while text is selected", () => {
		expect(allowsBrowserContextMenu(inside("[data-selectable]"), "")).toBe(
			false,
		);
		expect(allowsBrowserContextMenu(inside("[data-selectable]"), "  ")).toBe(
			false,
		);
		expect(allowsBrowserContextMenu(inside(".ctd-selectable"), "a quote")).toBe(
			true,
		);
		expect(allowsBrowserContextMenu(CHROME, "a quote")).toBe(false);
	});
});

describe("allowsNativeSelectAll", () => {
	it("selects all only inside fields", () => {
		expect(allowsNativeSelectAll(inside("textarea"))).toBe(true);
		expect(allowsNativeSelectAll(inside("[data-selectable]"))).toBe(false);
		expect(allowsNativeSelectAll(CHROME)).toBe(false);
	});
});

describe("allowsDragStart", () => {
	it("stops links and images dragging out unless marked draggable", () => {
		expect(allowsDragStart(inside("img"))).toBe(false);
		expect(allowsDragStart(inside("a, "))).toBe(false);
		expect(allowsDragStart(inside("img", '[draggable="true"]'))).toBe(true);
		expect(allowsDragStart(CHROME)).toBe(true);
	});
});
