import { describe, expect, it } from "vitest";
import { createDragOutGuard } from "./drag-out-guard";

const clock = () => {
	let time = 1_000;
	return {
		now: () => time,
		advance: (ms: number) => {
			time += ms;
		},
	};
};

describe("createDragOutGuard", () => {
	it("is inactive before any drag", () => {
		expect(createDragOutGuard().active()).toBe(false);
	});

	it("guards from the start of a drag until a moment after its end", () => {
		const time = clock();
		const guard = createDragOutGuard({ now: time.now, graceMs: 500 });
		guard.begin();
		time.advance(10_000);
		expect(guard.active()).toBe(true);
		guard.end();
		time.advance(499);
		expect(guard.active()).toBe(true);
		time.advance(1);
		expect(guard.active()).toBe(false);
	});

	it("gives up on a drag whose end never arrives", () => {
		const time = clock();
		const guard = createDragOutGuard({ now: time.now, maxMs: 60_000 });
		guard.begin();
		time.advance(60_000);
		expect(guard.active()).toBe(false);
	});

	it("ignores an end without a start", () => {
		const guard = createDragOutGuard();
		guard.end();
		expect(guard.active()).toBe(false);
	});

	it("starts afresh with each drag", () => {
		const time = clock();
		const guard = createDragOutGuard({ now: time.now, graceMs: 100 });
		guard.begin();
		guard.end();
		time.advance(200);
		guard.begin();
		expect(guard.active()).toBe(true);
	});
});
