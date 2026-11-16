import { describe, expect, it } from "vitest";
import {
	passesWindowDragThrough,
	WINDOW_DRAG_PASS_THROUGH,
} from "./window-drag";

const element = (matches: boolean) => ({
	closest: (selectors: string) => {
		expect(selectors).toBe(WINDOW_DRAG_PASS_THROUGH);
		return matches ? {} : null;
	},
});

describe("passesWindowDragThrough", () => {
	it("lets clicks through to controls", () => {
		expect(passesWindowDragThrough(element(true))).toBe(true);
	});

	it("drags over scrims, backgrounds and titles", () => {
		expect(passesWindowDragThrough(element(false))).toBe(false);
		expect(passesWindowDragThrough(null)).toBe(false);
	});

	it("covers the controls Tauri's drag script skips", () => {
		for (const selector of [
			"button",
			"a[href]",
			"input",
			'[role="tab"]',
			'[role="menuitem"]',
			'[tabindex]:not([tabindex="-1"])',
		]) {
			expect(WINDOW_DRAG_PASS_THROUGH.split(", ")).toContain(selector);
		}
	});
});
