import { describe, expect, it } from "vitest";
import {
	atRest,
	bounceVelocity,
	coverStep,
	DEFAULT_COVER_ROW,
	flingTarget,
	nearestCover,
	pastEdge,
	placeCover,
	scrollBy,
	springPath,
	springStep,
} from "./cover-row";

const params = DEFAULT_COVER_ROW;

describe("cover placement", () => {
	const ROW = 478;

	it("centres the current cover and lets neighbours peek in at the edges", () => {
		expect(placeCover(0, params, ROW)).toMatchObject({ x: 0, scale: 1 });
		const next = placeCover(1, params, ROW);
		expect(next.scale).toBe(params.sideScale);
		// The neighbour's inner edge sits a peek's width inside the row's edge.
		const innerEdge = next.x - (params.coverWidth * next.scale) / 2;
		expect(ROW / 2 - innerEdge).toBeCloseTo(params.peek * params.coverWidth);
		expect(placeCover(-1, params, ROW).x).toBe(-next.x);
	});

	it("moves and grows smoothly through the middle, nearer covers on top", () => {
		const half = placeCover(0.5, params, ROW);
		expect(half.x).toBeCloseTo(coverStep(params, ROW) / 2);
		expect(half.scale).toBeCloseTo(1 - (1 - params.sideScale) / 2);
		expect(placeCover(1, params, ROW).zIndex).toBeLessThan(
			placeCover(0, params, ROW).zIndex,
		);
	});

	it("keeps a gap between covers when the row is narrow", () => {
		expect(coverStep(params, 100)).toBe(params.coverWidth + 16);
	});
});

describe("cover row scrolling", () => {
	it("gives less past either end", () => {
		const one = params.pixelsPerCover;
		expect(scrollBy(0, -one, 5, params)).toBeCloseTo(-params.edgeResistance);
		expect(scrollBy(4, one, 5, params)).toBeCloseTo(4 + params.edgeResistance);
		expect(scrollBy(2, one, 5, params)).toBeCloseTo(3);
	});

	it("knows which end a position has been pulled past", () => {
		expect(pastEdge(-0.05, 12)).toBe(0);
		expect(pastEdge(11.2, 12)).toBe(11);
		expect(pastEdge(5, 12)).toBeUndefined();
		expect(pastEdge(0, 12)).toBeUndefined();
	});

	it("bounces off an end quickly, nudging out only a little", () => {
		// A hard flick's momentum: 120px in one 16ms frame.
		const outwards = bounceVelocity(120, 0.016, params);
		expect(outwards).toBeGreaterThan(0);
		expect(outwards).toBeLessThanOrEqual(12);
		expect(bounceVelocity(8, 0.016, params)).toBeLessThan(outwards);
		expect(bounceVelocity(-120, 0.016, params)).toBe(-outwards);
		let spring = { position: 11.1, velocity: outwards };
		let furthest = spring.position;
		let frames = 0;
		while (frames < 120 && !atRest(spring, 11)) {
			spring = springStep(spring, 11, 1 / 60, params.edgeStiffness);
			furthest = Math.max(furthest, spring.position);
			frames++;
		}
		expect(furthest - 11).toBeLessThan(0.25);
		// Out and back in well under half a second.
		expect(frames / 60).toBeLessThan(0.45);
	});

	it("settles on the nearest cover without overshooting", () => {
		let spring = { position: 2.4, velocity: 0 };
		const target = nearestCover(spring.position, 5);
		let highest = spring.position;
		for (let frame = 0; frame < 120 && !atRest(spring, target); frame++) {
			spring = springStep(spring, target, 1 / 60, params.stiffness);
			highest = Math.max(highest, spring.position);
		}
		expect(target).toBe(2);
		expect(spring.position).toBeCloseTo(2, 2);
		expect(highest).toBe(2.4);
	});

	it("stays steady through long, stalled or out-of-order frames", () => {
		for (const seconds of [0.25, 1, -0.01]) {
			let spring = { position: 11.2, velocity: 12 };
			for (let frame = 0; frame < 20; frame++)
				spring = springStep(spring, 11, seconds, params.edgeStiffness);
			expect(Number.isFinite(spring.position)).toBe(true);
			expect(Math.abs(spring.position - 11)).toBeLessThan(0.3);
		}
	});

	it("works out a settle's whole path ahead, ending exactly on the cover", () => {
		const start = { position: 11.2, velocity: 6 };
		const path = springPath(start, 11, params.edgeStiffness);
		expect(path[0]).toBe(11.2);
		expect(path.at(-1)).toBe(11);
		// The same exact spring, sampled: it nudges out, then comes back.
		expect(Math.max(...path)).toBeGreaterThan(11.2);
		expect(path.length).toBeLessThan(0.5 * 120);
		expect(springPath({ position: 3, velocity: 0 }, 3, 260)).toEqual([3, 3]);
	});

	it("carries a flung drag on to where its momentum would land", () => {
		expect(flingTarget(1.2, 0, 10)).toBe(1);
		expect(flingTarget(1.2, 12, 10)).toBe(3);
		expect(flingTarget(1.2, -40, 10)).toBe(0);
	});
});
