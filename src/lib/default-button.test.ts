import { describe, expect, it } from "vitest";
import {
	type DefaultButtonKeyEvent,
	isDefaultButtonKey,
} from "./default-button";

const press = (
	overrides: Partial<DefaultButtonKeyEvent> = {},
): DefaultButtonKeyEvent => ({
	key: "Enter",
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	target: { tagName: "BUTTON" },
	...overrides,
});

describe("isDefaultButtonKey", () => {
	it("takes a plain Return wherever focus is", () => {
		expect(isDefaultButtonKey(press())).toBe(true);
		expect(isDefaultButtonKey(press({ target: { tagName: "INPUT" } }))).toBe(
			true,
		);
	});

	it("leaves other keys, chords and IME composition alone", () => {
		expect(isDefaultButtonKey(press({ key: " " }))).toBe(false);
		expect(isDefaultButtonKey(press({ shiftKey: true }))).toBe(false);
		expect(isDefaultButtonKey(press({ metaKey: true }))).toBe(false);
		expect(
			isDefaultButtonKey(press({ nativeEvent: { isComposing: true } })),
		).toBe(false);
	});

	it("keeps Return as a new line in multi-line text", () => {
		expect(isDefaultButtonKey(press({ target: { tagName: "TEXTAREA" } }))).toBe(
			false,
		);
		expect(
			isDefaultButtonKey(
				press({ target: { tagName: "DIV", isContentEditable: true } }),
			),
		).toBe(false);
	});
});
