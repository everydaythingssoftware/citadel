import { describe, expect, it, vi } from "vitest";
import { contextMenuPoint, fromKeyboard } from "./context-menu-point";

const trigger = (clientX: number, clientY: number, button: number) => ({
	clientX,
	clientY,
	button,
	preventDefault: vi.fn(),
});

describe("fromKeyboard", () => {
	it("tells a right-click from the Menu key", () => {
		expect(fromKeyboard(trigger(120, 80, 2))).toBe(false);
		expect(fromKeyboard(trigger(0, 0, 2))).toBe(true);
		expect(fromKeyboard(trigger(120, 80, 0))).toBe(true);
	});
});

describe("contextMenuPoint", () => {
	it("keeps the pointer position for a right-click", () => {
		const event = trigger(120, 80, 2);
		expect(contextMenuPoint(event, { left: 10, bottom: 40 })).toBe(event);
	});

	it("opens under the anchor from the keyboard and still prevents default", () => {
		const event = trigger(0, 0, 0);
		const point = contextMenuPoint(event, { left: 10, bottom: 40 });
		expect(point).toMatchObject({ clientX: 18, clientY: 40 });
		point.preventDefault();
		expect(event.preventDefault).toHaveBeenCalled();
	});

	it("falls back to the event without an anchor", () => {
		const event = trigger(0, 0, 0);
		expect(contextMenuPoint(event, null)).toBe(event);
	});
});
