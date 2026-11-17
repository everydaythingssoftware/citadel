import { describe, expect, it } from "vitest";
import { menuRoom, unclippedMenuHeight } from "./select-menu-fit";

const near = { room: 680, height: 76, fullHeight: 99, scrollTop: 24 };

describe("unclippedMenuHeight", () => {
	it("grows a short menu that was shortened and scrolled near the top", () => {
		expect(unclippedMenuHeight(near)).toBe(99);
	});

	it("unscrolls a menu that is tall enough but kept its scroll", () => {
		expect(unclippedMenuHeight({ ...near, height: 99 })).toBe(99);
	});

	it("leaves a menu that already shows every item", () => {
		expect(
			unclippedMenuHeight({ ...near, height: 99, scrollTop: 0 }),
		).toBeNull();
	});

	it("leaves a long list scrolling when it can't fit", () => {
		expect(
			unclippedMenuHeight({ ...near, fullHeight: 900, height: 680 }),
		).toBeNull();
		expect(unclippedMenuHeight({ ...near, room: 50 })).toBeNull();
	});
});

describe("menuRoom", () => {
	it("measures down from the top of a menu pinned to its top", () => {
		expect(
			menuRoom({
				top: 10,
				bottom: 86,
				viewportHeight: 700,
				pinnedToBottom: false,
			}),
		).toBe(680);
	});

	it("measures up from the bottom of a menu pinned to its bottom", () => {
		expect(
			menuRoom({
				top: 414,
				bottom: 490,
				viewportHeight: 500,
				pinnedToBottom: true,
			}),
		).toBe(480);
	});
});
