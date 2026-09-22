import { describe, expect, it } from "vitest";
import type { SwitchEvent, SwitchSnapshot } from "./machine";
import {
	CURTAIN_IN_MS,
	CURTAIN_OUT_MS,
	FIRST_PULSE_MS,
	PULSE_MS,
	initSwitch,
	msToPulseBoundary,
	progressFor,
	transition,
} from "./machine";

const run = (start: SwitchSnapshot, events: SwitchEvent[]): SwitchSnapshot => {
	let snapshot = start;
	for (const event of events) {
		snapshot = transition(snapshot, event);
	}
	return snapshot;
};

const CALIBRE = "Calibre Library";
const RESEARCH = "Research";

const started = (name = CALIBRE): SwitchSnapshot =>
	run(initSwitch(), [{ type: "SWITCH_STARTED", name }]);

const working = (name = CALIBRE): SwitchSnapshot =>
	run(started(name), [{ type: "FADE_IN_ELAPSED" }]);

const revealing = (): SwitchSnapshot => run(working(), [{ type: "READY" }]);

/** Every non-idle stage carries the pseudo-progress value. */
const progressOf = (snapshot: SwitchSnapshot): number => {
	if (snapshot.stage.id === "idle") throw new Error("unexpected idle stage");
	return snapshot.stage.progress;
};

describe("arming from idle", () => {
	it("SWITCH_STARTED arms the curtain with the target name at zero progress", () => {
		expect(started().stage).toEqual({
			id: "arming",
			name: CALIBRE,
			progress: 0,
		});
	});

	it("idle ignores every other event", () => {
		const idle = initSwitch();
		const pokes: SwitchEvent[] = [
			{ type: "READY" },
			{ type: "FAILED", message: "boom" },
			{ type: "FADE_IN_ELAPSED" },
			{ type: "TICK", elapsedMs: 5000 },
			{ type: "REVEAL_ELAPSED" },
		];
		for (const event of pokes) {
			expect(transition(idle, event)).toBe(idle);
		}
	});
});

describe("fade-in", () => {
	it("FADE_IN_ELAPSED commits to working, keeping the progress earned while fading in", () => {
		const committed = run(started(), [
			{ type: "TICK", elapsedMs: 60 },
			{ type: "FADE_IN_ELAPSED" },
		]);
		expect(committed.stage).toMatchObject({ id: "working", name: CALIBRE });
		expect(progressOf(committed)).toBeGreaterThan(0);
	});

	it("FADE_IN_ELAPSED is inert outside arming", () => {
		const snapshot = working();
		expect(transition(snapshot, { type: "FADE_IN_ELAPSED" })).toBe(snapshot);
	});

	it("READY during the fade-in goes straight to the reveal at full progress — the shell withholds it until a pulse boundary", () => {
		expect(run(started(), [{ type: "READY" }]).stage).toEqual({
			id: "revealing",
			name: CALIBRE,
			progress: 100,
		});
	});
});

describe("working", () => {
	it("the first pulse sweeps fast across the bar", () => {
		expect(progressFor(0)).toBe(0);
		const midFirst = progressFor(FIRST_PULSE_MS / 2);
		expect(midFirst).toBeGreaterThan(25);
		expect(midFirst).toBeLessThan(75);
		expect(progressFor(FIRST_PULSE_MS)).toBe(100);
	});

	it("later pulses restart the sweep and pace slower", () => {
		expect(progressFor(FIRST_PULSE_MS + 1)).toBeLessThan(15);
		const midSlow = progressFor(FIRST_PULSE_MS + PULSE_MS / 2);
		expect(midSlow).toBeGreaterThan(25);
		expect(midSlow).toBeLessThan(75);
		// Just inside the sweep's end; at the boundary itself the next
		// pulse begins.
		expect(progressFor(FIRST_PULSE_MS + PULSE_MS - 1)).toBe(100);
	});

	it("each pulse is monotonic within the sweep", () => {
		let previous = progressFor(FIRST_PULSE_MS + 25);
		for (
			let elapsed = FIRST_PULSE_MS + 50;
			elapsed < FIRST_PULSE_MS + PULSE_MS;
			elapsed += 25
		) {
			const current = progressFor(elapsed);
			expect(current).toBeGreaterThanOrEqual(previous);
			previous = current;
		}
		expect(progressFor(FIRST_PULSE_MS + PULSE_MS - 1)).toBe(100);
	});

	it("ready snaps the bar to 100% and starts the reveal", () => {
		const { stage } = run(working(), [
			{ type: "TICK", elapsedMs: 400 },
			{ type: "READY" },
		]);
		expect(stage).toEqual({ id: "revealing", name: CALIBRE, progress: 100 });
	});

	it("failed lifts the curtain too, keeping the bar where it was", () => {
		const failed = run(working(), [
			{ type: "TICK", elapsedMs: 400 },
			{ type: "FAILED", message: "metadata.db is locked" },
		]);
		expect(failed.stage).toMatchObject({ id: "revealing", name: CALIBRE });
		expect(progressOf(failed)).toBeGreaterThan(0);
	});
});

describe("msToPulseBoundary", () => {
	it("holds the first pulse to its fast boundary", () => {
		expect(msToPulseBoundary(0)).toBe(FIRST_PULSE_MS);
		expect(msToPulseBoundary(120)).toBe(FIRST_PULSE_MS - 120);
		expect(msToPulseBoundary(FIRST_PULSE_MS)).toBe(PULSE_MS);
	});

	it("holds later pulses to the slow boundary", () => {
		const midSlow = FIRST_PULSE_MS + PULSE_MS / 2;
		expect(msToPulseBoundary(midSlow)).toBe(PULSE_MS / 2);
		expect(msToPulseBoundary(FIRST_PULSE_MS + PULSE_MS)).toBe(PULSE_MS);
	});
});

describe("revealing", () => {
	it("returns to idle once the fade-out elapses", () => {
		expect(transition(revealing(), { type: "REVEAL_ELAPSED" }).stage).toEqual({
			id: "idle",
		});
	});

	it("ignores stale ready/failed/tick/fade-in events while revealing", () => {
		const snapshot = revealing();
		const stale: SwitchEvent[] = [
			{ type: "READY" },
			{ type: "FAILED", message: "boom" },
			{ type: "TICK", elapsedMs: 5000 },
			{ type: "FADE_IN_ELAPSED" },
		];
		for (const event of stale) {
			expect(transition(snapshot, event)).toBe(snapshot);
		}
	});

	it("a new switch during the reveal rearms with the fresh name", () => {
		expect(
			transition(revealing(), { type: "SWITCH_STARTED", name: RESEARCH }).stage,
		).toEqual({ id: "arming", name: RESEARCH, progress: 0 });
	});
});

describe("rapid re-switch", () => {
	it("a second switch while arming restarts with the new name and resets progress", () => {
		const restarted = run(started(), [
			{ type: "TICK", elapsedMs: 200 },
			{ type: "SWITCH_STARTED", name: RESEARCH },
		]);
		expect(restarted.stage).toEqual({
			id: "arming",
			name: RESEARCH,
			progress: 0,
		});
	});

	it("a second switch while working rearms, and the fresh target's ready starts a new reveal at 100%", () => {
		const restarted = run(working(), [
			{ type: "SWITCH_STARTED", name: RESEARCH },
			{ type: "READY" },
		]);
		expect(restarted.stage).toEqual({
			id: "revealing",
			name: RESEARCH,
			progress: 100,
		});
	});
});

describe("timing constants", () => {
	it("keep the curtain rhythm and pulse pacing", () => {
		expect(CURTAIN_IN_MS).toBe(120);
		expect(CURTAIN_OUT_MS).toBe(320);
		expect(FIRST_PULSE_MS).toBeGreaterThanOrEqual(400);
		expect(FIRST_PULSE_MS).toBeLessThanOrEqual(600);
		expect(PULSE_MS).toBe(1400);
	});
});
