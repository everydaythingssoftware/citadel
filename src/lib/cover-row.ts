/**
 * A row of covers moved by Cover Flow's momentum and physics: the current
 * cover in the middle, its neighbours peeking in at the edges, slightly
 * smaller. Everything here is pure: where each cover goes for a (fractional)
 * scroll position, and how trackpad scrolling and settling move that position.
 */

export interface CoverRowParams {
	/** Cover width in px. */
	coverWidth: number;
	/** How much of a neighbour shows at each edge, in cover widths. */
	peek: number;
	/** Neighbours' size relative to the current cover. */
	sideScale: number;
	/** Trackpad scrolling (px) that moves one cover. */
	pixelsPerCover: number;
	/** Settling spring stiffness; higher settles faster. */
	stiffness: number;
	/** How much scrolling past either end still moves (0–1). */
	edgeResistance: number;
}

export const DEFAULT_COVER_ROW: CoverRowParams = {
	coverWidth: 112,
	peek: 0.3,
	sideScale: 0.88,
	pixelsPerCover: 90,
	stiffness: 260,
	edgeResistance: 0.3,
};

export interface CoverPlacement {
	x: number;
	scale: number;
	zIndex: number;
}

/**
 * Centre to centre, in px: what's left of half the row once the current
 * cover and the neighbour's peek are taken out, plus a cover. Shrinking a
 * neighbour (from its bottom middle) pulls its inner edge back by half the
 * lost width, which the gap gives back.
 */
export const coverStep = (params: CoverRowParams, rowWidth: number): number => {
	const { coverWidth, peek, sideScale } = params;
	const gap =
		rowWidth / 2 -
		coverWidth * (0.5 + peek) -
		(coverWidth * (1 - sideScale)) / 2;
	return coverWidth + Math.max(16, gap);
};

/** Where a cover `offset` places from the middle (fractional) goes. */
export const placeCover = (
	offset: number,
	params: CoverRowParams,
	rowWidth: number,
): CoverPlacement => {
	const near = Math.min(Math.abs(offset), 1);
	return {
		x: offset * coverStep(params, rowWidth),
		scale: 1 - near * (1 - params.sideScale),
		zIndex: 1000 - Math.round(Math.abs(offset) * 10),
	};
};

/** The cover nearest a position, within the stack. */
export const nearestCover = (position: number, count: number): number =>
	Math.max(0, Math.min(count - 1, Math.round(position)));

/**
 * Moves the position by a trackpad delta, OS momentum included, so a flick
 * spins through covers and slows as the fingers' momentum does. Past either
 * end it gives less and less, like the rest of macOS.
 */
export const scrollBy = (
	position: number,
	deltaPx: number,
	count: number,
	params: CoverRowParams,
): number => {
	const step = deltaPx / params.pixelsPerCover;
	const next = position + step;
	const end = Math.max(0, count - 1);
	const outside = next < 0 || next > end;
	return outside ? position + step * params.edgeResistance : next;
};

export interface Spring {
	position: number;
	velocity: number;
}

/**
 * One step of a critically damped spring towards `target`: settles as fast
 * as it can without overshooting, so covers glide into place without a
 * wobble at the end.
 */
export const springStep = (
	{ position, velocity }: Spring,
	target: number,
	seconds: number,
	stiffness: number,
): Spring => {
	const damping = 2 * Math.sqrt(stiffness);
	const acceleration = stiffness * (target - position) - damping * velocity;
	const nextVelocity = velocity + acceleration * seconds;
	return {
		position: position + nextVelocity * seconds,
		velocity: nextVelocity,
	};
};

/** Close enough to rest that the spring can stop. */
export const atRest = ({ position, velocity }: Spring, target: number) =>
	Math.abs(target - position) < 0.001 && Math.abs(velocity) < 0.01;

/**
 * Where a drag released with this velocity (covers per second) settles: the
 * cover its momentum would carry it to, like a flick on iOS.
 */
export const flingTarget = (
	position: number,
	velocity: number,
	count: number,
): number => nearestCover(position + velocity * 0.18, count);
