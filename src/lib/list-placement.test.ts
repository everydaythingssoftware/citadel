import { describe, expect, it } from "vitest";
import { placeList } from "./list-placement";

const field = (top: number) => ({
	top,
	bottom: top + 40,
	left: 10,
	width: 300,
});
const screen = { top: 0, bottom: 800 };

describe("placeList", () => {
	it("opens under the field when there's room", () => {
		expect(placeList(field(100), screen)).toEqual({
			left: 10,
			top: 144,
			width: 300,
			maxHeight: 180,
			above: false,
		});
	});

	it("opens above when there's more room there, without passing the top", () => {
		// The keyboard leaves 300px visible; the field sits near its bottom.
		const placement = placeList(field(200), { top: 0, bottom: 300 });
		expect(placement?.above).toBe(true);
		expect(placement?.top).toBe(196);
		expect(placement?.maxHeight).toBe(180);
		const tight = placeList(field(120), { top: 0, bottom: 200 });
		expect(tight?.above).toBe(true);
		expect(tight?.maxHeight).toBe(120 - 4 - 8);
	});

	it("measures against the visible area when it's scrolled", () => {
		const placement = placeList(field(500), { top: 400, bottom: 700 });
		expect(placement?.above).toBe(false);
		expect(placement?.maxHeight).toBe(700 - 540 - 4 - 8);
	});

	it("shows nothing rather than a sliver, or for a field out of view", () => {
		expect(placeList(field(20), { top: 0, bottom: 110 })).toBeUndefined();
		expect(placeList(field(900), screen)).toBeUndefined();
		expect(placeList(field(-60), screen)).toBeUndefined();
	});
});
