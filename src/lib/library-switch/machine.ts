/**
 * CDL-27 library-switch curtain — pure state machine (functional core).
 *
 * `transition(snapshot, event)` returns the next snapshot; the imperative
 * shell (`use-library-switch.ts`) owns every timer and translates the
 * library store's real milestones into events, so the reducer stays total
 * and synchronous. The shell only dispatches `SWITCH_STARTED` when the
 * switch departs from an established ready library — first boot, the
 * first-run flow, and broken-path boots never arm the curtain.
 *
 * Visual contract: fade to a neutral curtain (120ms), centered
 * "Opening '<name>'" with a pulsing determinate bar, snap to 100% on ready,
 * 320ms fade-out revealing the new library in full. The bar sweeps in
 * pulses: the first is fast (FIRST_PULSE_MS) so instant switches read as
 * snappy, later pulses pace slower (PULSE_MS) while real work continues.
 * The shell withholds READY until a pulse boundary, so the bar always
 * completes its current sweep before the reveal — a fast open must never
 * flash a single blank frame between the outgoing and incoming library.
 */

/** Curtain fade-in duration. */
export const CURTAIN_IN_MS = 120;
/** Curtain fade-out duration. */
export const CURTAIN_OUT_MS = 320;
/** First bar sweep: quick enough to feel immediate, long enough to read
 * as an intentional beat rather than a flicker. */
export const FIRST_PULSE_MS = 500;
/** Pace of every bar sweep after the first, while a slow open continues. */
export const PULSE_MS = 1400;

export type SwitchStage =
	| { id: "idle" }
	| { id: "arming"; name: string; progress: number }
	| { id: "working"; name: string; progress: number }
	| { id: "revealing"; name: string; progress: number };

export interface SwitchSnapshot {
	stage: SwitchStage;
}

export type SwitchEvent =
	| { type: "SWITCH_STARTED"; name: string }
	| { type: "FADE_IN_ELAPSED" }
	| { type: "TICK"; elapsedMs: number }
	| { type: "READY" }
	| { type: "FAILED"; message: string }
	| { type: "REVEAL_ELAPSED" };

export const initSwitch = (): SwitchSnapshot => ({ stage: { id: "idle" } });

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Bar position as a sawtooth of pulses: the first sweep is fast so instant
 * switches read as snappy; later sweeps pace slower while real work
 * continues. Each pulse eases in and out so the turns aren't jagged. */
export const progressFor = (elapsedMs: number): number => {
	if (elapsedMs <= 0) return 0;
	if (elapsedMs <= FIRST_PULSE_MS) {
		return Math.round(100 * smoothstep(elapsedMs / FIRST_PULSE_MS));
	}
	const afterFirst = elapsedMs - FIRST_PULSE_MS;
	const t = (afterFirst % PULSE_MS) / PULSE_MS;
	return Math.round(100 * smoothstep(t));
};

/** Time from `elapsedMs` until the current pulse completes its sweep — the
 * earliest moment a READY may be revealed without cutting the bar short. */
export const msToPulseBoundary = (elapsedMs: number): number => {
	if (elapsedMs < FIRST_PULSE_MS) return FIRST_PULSE_MS - elapsedMs;
	const afterFirst = elapsedMs - FIRST_PULSE_MS;
	return PULSE_MS - (afterFirst % PULSE_MS);
};

export const transition = (
	snapshot: SwitchSnapshot,
	event: SwitchEvent,
): SwitchSnapshot => {
	const { stage } = snapshot;

	switch (stage.id) {
		case "idle":
			if (event.type === "SWITCH_STARTED") {
				return { stage: { id: "arming", name: event.name, progress: 0 } };
			}
			return snapshot;

		case "arming":
			switch (event.type) {
				case "SWITCH_STARTED":
					return { stage: { id: "arming", name: event.name, progress: 0 } };
				case "TICK":
					return {
						stage: { ...stage, progress: progressFor(event.elapsedMs) },
					};
				case "FADE_IN_ELAPSED":
					return {
						stage: {
							id: "working",
							name: stage.name,
							progress: stage.progress,
						},
					};
				// The open finished early; the shell withholds READY until the
				// bar has finished one full sweep, so the reveal always starts
				// after the traverse.
				case "READY":
					return {
						stage: { id: "revealing", name: stage.name, progress: 100 },
					};
				case "FAILED":
					return {
						stage: {
							id: "revealing",
							name: stage.name,
							progress: stage.progress,
						},
					};
				default:
					return snapshot;
			}

		case "working":
			switch (event.type) {
				case "SWITCH_STARTED":
					return { stage: { id: "arming", name: event.name, progress: 0 } };
				case "TICK":
					return {
						stage: { ...stage, progress: progressFor(event.elapsedMs) },
					};
				case "READY":
					return {
						stage: { id: "revealing", name: stage.name, progress: 100 },
					};
				case "FAILED":
					return {
						stage: {
							id: "revealing",
							name: stage.name,
							progress: stage.progress,
						},
					};
				default:
					return snapshot;
			}

		case "revealing":
			if (event.type === "REVEAL_ELAPSED") {
				return { stage: { id: "idle" } };
			}
			if (event.type === "SWITCH_STARTED") {
				return { stage: { id: "arming", name: event.name, progress: 0 } };
			}
			return snapshot;
	}
};
