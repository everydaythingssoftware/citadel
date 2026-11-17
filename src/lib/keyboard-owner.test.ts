import { describe, expect, it } from "vitest";
import {
	type KeyboardOwnerTarget,
	keyboardBusyAt,
	overlayBlocksAppChords,
} from "./keyboard-owner";

const element = (
	fields: Partial<KeyboardOwnerTarget>,
	inside: string[] = [],
): KeyboardOwnerTarget => ({
	tagName: "DIV",
	closest: (selector: string) =>
		inside.some((part) => selector.includes(part)) ? {} : null,
	...fields,
});

describe("keyboardBusyAt", () => {
	it("is free with nothing or the grid focused", () => {
		expect(keyboardBusyAt(null)).toBe(false);
		expect(keyboardBusyAt(element({}))).toBe(false);
	});

	it("is busy in a text field or editable content", () => {
		expect(keyboardBusyAt(element({ tagName: "INPUT", type: "text" }))).toBe(
			true,
		);
		expect(keyboardBusyAt(element({ tagName: "TEXTAREA" }))).toBe(true);
		expect(keyboardBusyAt(element({ isContentEditable: true }))).toBe(true);
	});

	it("is free on a checkbox", () => {
		expect(
			keyboardBusyAt(element({ tagName: "INPUT", type: "checkbox" })),
		).toBe(false);
	});

	it("is busy inside an alert or sheet", () => {
		expect(keyboardBusyAt(element({}, ['[role="alertdialog"]']))).toBe(true);
	});
});

describe("overlayBlocksAppChords", () => {
	const dialog = (attributes: string[]) => ({
		hasAttribute: (name: string) => attributes.includes(name),
	});

	it("leaves app-wide chords working beside the details panel", () => {
		expect(overlayBlocksAppChords([])).toBe(false);
		expect(overlayBlocksAppChords([dialog(["data-drawer"])])).toBe(false);
	});

	it("holds them while a sheet or alert is open", () => {
		expect(overlayBlocksAppChords([dialog([])])).toBe(true);
		expect(overlayBlocksAppChords([dialog(["data-drawer"]), dialog([])])).toBe(
			true,
		);
	});
});
