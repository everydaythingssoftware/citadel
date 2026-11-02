/**
 * How trackpad scrolling moves a cover row: one gesture's events in, where
 * the row goes and when it settles out. Pure, so the app's hook and the tests
 * run exactly the same logic.
 */
import {
	bounceVelocity,
	type CoverRowParams,
	nearestCover,
	pastEdge,
	scrollBy,
} from "@/lib/cover-row";

/** No wheel events for this long: the swipe and its momentum are over. */
export const WHEEL_IDLE_MS = 70;
/**
 * Past an end, scrolling slower than this share of the gesture's top speed
 * is momentum running out (or the fingers stopping): bounce back now.
 */
const EDGE_LET_GO = 0.8;
/** Momentum events this small (px), once settling, are only the tail. */
const TAIL_PX = 4;

export interface WheelGesture {
	/** A gesture is under way (events closer together than the idle gap). */
	active: boolean;
	lastAt: number;
	speed: number;
	peak: number;
	/** Momentum has faded and the row is already settling. */
	drifting: boolean;
	/** The direction of a bounce off an end; the rest of that push is ignored. */
	bounced: number;
}

export const WHEEL_AT_REST: WheelGesture = {
	active: false,
	lastAt: Number.NEGATIVE_INFINITY,
	speed: 0,
	peak: 0,
	drifting: false,
	bounced: 0,
};

export type WheelOutcome =
	| { kind: "ignore" }
	| { kind: "move"; position: number }
	| { kind: "settle"; position: number; target: number }
	| { kind: "bounce"; position: number; target: number; velocity: number };

/**
 * One wheel event. `position` is read only when the event moves the row,
 * so the caller can stop a settle in flight first and hand over where it
 * had got to.
 */
export const wheelEvent = (
	gesture: WheelGesture,
	delta: number,
	at: number,
	count: number,
	params: CoverRowParams,
	position: () => number,
): { gesture: WheelGesture; outcome: WheelOutcome } => {
	const gap = at - gesture.lastAt;
	const next: WheelGesture = { ...gesture, lastAt: at };
	if (next.bounced === Math.sign(delta))
		return { gesture: next, outcome: { kind: "ignore" } };
	next.bounced = 0;
	// The tail of a flick that's already settling: let it go.
	if (next.drifting && gap < WHEEL_IDLE_MS && Math.abs(delta) < TAIL_PX)
		return { gesture: next, outcome: { kind: "ignore" } };
	next.drifting = false;
	next.active = true;
	const moved = scrollBy(position(), delta, count, params);
	const rate = Math.abs(delta) / Math.max(4, gap);
	next.speed = next.speed * 0.6 + rate * 0.4;
	next.peak = Math.max(next.peak, next.speed);
	// Past an end and no longer speeding up: like macOS, spring straight
	// back, carrying on outwards only as far as the bounce's own speed.
	const edge = pastEdge(moved, count);
	if (edge !== undefined && next.speed < next.peak * EDGE_LET_GO) {
		next.bounced = Math.sign(delta);
		return {
			gesture: next,
			outcome: {
				kind: "bounce",
				position: moved,
				target: edge,
				velocity: bounceVelocity(delta, gap / 1000, params),
			},
		};
	}
	// Momentum fading below a share of the swipe's top speed is only
	// drifting on: settle now rather than creep the last few pixels.
	if (next.peak > 0.5 && next.speed < next.peak * params.driftShare) {
		next.drifting = true;
		return {
			gesture: next,
			outcome: {
				kind: "settle",
				position: moved,
				target: nearestCover(moved, count),
			},
		};
	}
	return { gesture: next, outcome: { kind: "move", position: moved } };
};

/**
 * The gesture has gone quiet. Returns the cover to settle on (the nearest),
 * unless the row is already settling after a drift or a bounce.
 */
export const wheelIdle = (
	gesture: WheelGesture,
	position: number,
	count: number,
): { gesture: WheelGesture; target: number | undefined } => {
	const settling = gesture.drifting || gesture.bounced !== 0;
	return {
		gesture: { ...WHEEL_AT_REST, lastAt: gesture.lastAt },
		target: settling ? undefined : nearestCover(position, count),
	};
};
