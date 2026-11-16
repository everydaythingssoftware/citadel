import { describe, expect, it } from "vitest";
import { panelTakesEscape } from "./panel-escape";

describe("panelTakesEscape", () => {
	it("takes the press wherever focus is", () => {
		expect(panelTakesEscape(null, false)).toBe(true);
		expect(panelTakesEscape({ tagName: "BODY" }, false)).toBe(true);
		expect(panelTakesEscape({ tagName: "DIV" }, false)).toBe(true);
		expect(panelTakesEscape({ tagName: "BUTTON" }, false)).toBe(true);
	});

	it("leaves it to a menu, pop-up, sheet or alert on top", () => {
		expect(panelTakesEscape({ tagName: "DIV" }, true)).toBe(false);
	});

	it("lets a field with text clear it first", () => {
		const field = { tagName: "INPUT", type: "search" };
		expect(panelTakesEscape({ ...field, value: "eliot" }, false)).toBe(false);
		expect(panelTakesEscape({ ...field, value: "" }, false)).toBe(true);
		expect(
			panelTakesEscape({ tagName: "TEXTAREA", value: "notes" }, false),
		).toBe(false);
	});

	it("is not held up by a checked checkbox", () => {
		expect(
			panelTakesEscape(
				{ tagName: "INPUT", type: "checkbox", value: "on" },
				false,
			),
		).toBe(true);
	});
});
