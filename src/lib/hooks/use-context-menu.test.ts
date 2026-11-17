import { describe, expect, it, vi } from "vitest";
import { keyboardMenuEvent } from "./use-context-menu";

const press = (key: string, shiftKey = false) => ({
	key,
	shiftKey,
	preventDefault: vi.fn(),
});

describe("keyboardMenuEvent", () => {
	it("opens below the control for the Menu key and Shift+F10", () => {
		const key = press("ContextMenu");
		const opened = keyboardMenuEvent(key, { left: 20, bottom: 100 });
		expect(opened).toMatchObject({
			isSome: true,
			value: { clientX: 28, clientY: 100 },
		});
		if (opened.isSome) opened.value.preventDefault();
		expect(key.preventDefault).toHaveBeenCalledOnce();
		expect(
			keyboardMenuEvent(press("F10", true), { left: 0, bottom: 0 }).isSome,
		).toBe(true);
	});

	it("ignores other keys", () => {
		expect(keyboardMenuEvent(press("F10"), { left: 0, bottom: 0 }).isSome).toBe(
			false,
		);
		expect(keyboardMenuEvent(press("a"), { left: 0, bottom: 0 }).isSome).toBe(
			false,
		);
	});
});
