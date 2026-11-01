import { describe, expect, it } from "vitest";
import { DEFAULT_COVER_ROW } from "./cover-row";
import { WHEEL_AT_REST, wheelEvent, wheelIdle } from "./cover-wheel";

const params = DEFAULT_COVER_ROW;
/** A light flick: fingers, then the system's fading momentum. */
const flick = (scale: number, from = 0) =>
	[2, 6, 14, 22, 26, 22, 16, 11, 8, 6, 4, 3, 2, 2, 1, 1].map((dx, i) => ({
		dx: dx * scale,
		at: from + i * 16,
	}));

describe("where a swipe settles", () => {
	it("settles on the nearest cover once the swipe goes quiet", () => {
		const active = { ...WHEEL_AT_REST, active: true };
		expect(wheelIdle(active, 1.4, 10).target).toBe(1);
		expect(wheelIdle(active, 1.6, 10).target).toBe(2);
	});

	it("never settles beyond either end", () => {
		const active = { ...WHEEL_AT_REST, active: true };
		expect(wheelIdle(active, -0.4, 10).target).toBe(0);
		expect(wheelIdle(active, 12, 10).target).toBe(9);
	});

	it("leaves a settle already under way alone", () => {
		const drifting = { ...WHEEL_AT_REST, active: true, drifting: true };
		expect(wheelIdle(drifting, 3.3, 10).target).toBeUndefined();
	});
});

/** Where a gesture's events carry the row, before it settles. */
const travel = (events: { dx: number; at: number }[], start: number) => {
	let gesture = WHEEL_AT_REST;
	let position = start;
	for (const { dx, at } of events) {
		const step = wheelEvent(gesture, dx, at, 40, params, () => position);
		gesture = step.gesture;
		if (step.outcome.kind !== "ignore") position = step.outcome.position;
	}
	return { gesture, position };
};

describe("following a swipe", () => {
	it("travels further for a harder flick, and the other way for a reverse one", () => {
		const soft = travel(flick(1), 20).position;
		const hard = travel(flick(4), 20).position;
		const back = travel(flick(-4), 20).position;
		expect(soft).toBeGreaterThan(20);
		expect(hard).toBeGreaterThan(soft);
		expect(back).toBeCloseTo(40 - hard);
	});

	it("starts a gesture and moves the row with its first event", () => {
		const { gesture, position } = travel(flick(2, 1000), 3);
		expect(gesture.active).toBe(true);
		expect(position).toBeGreaterThan(3);
	});
});
