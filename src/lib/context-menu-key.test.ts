import { describe, expect, it, vi } from "vitest";
import { isContextMenuKey, keyboardMenuAnchor } from "./context-menu-key";

describe("isContextMenuKey", () => {
	it("knows the Menu key and Shift+F10", () => {
		expect(isContextMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(
			true,
		);
		expect(isContextMenuKey({ key: "F10", shiftKey: true })).toBe(true);
		expect(isContextMenuKey({ key: "F10", shiftKey: false })).toBe(false);
		expect(isContextMenuKey({ key: "Enter", shiftKey: false })).toBe(false);
	});
});

describe("keyboardMenuAnchor", () => {
	it("anchors below the control and prevents the key's default", () => {
		const preventDefault = vi.fn();
		const anchor = keyboardMenuAnchor(
			{ key: "ContextMenu", shiftKey: false, preventDefault },
			{ left: 20, bottom: 100 },
		);
		expect(anchor).toMatchObject({ clientX: 28, clientY: 100 });
		anchor?.preventDefault();
		expect(preventDefault).toHaveBeenCalledOnce();
	});

	it("ignores other keys", () => {
		expect(
			keyboardMenuAnchor(
				{ key: "a", shiftKey: false, preventDefault: () => {} },
				{ left: 0, bottom: 0 },
			),
		).toBeNull();
	});
});
