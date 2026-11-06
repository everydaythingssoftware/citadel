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
	/** Spring stiffness snapping back from past either end; higher is quicker. */
	edgeStiffness: number;
	/**
	 * Momentum fading below this share of a swipe's top speed is only
	 * drifting on, and the row settles there.
	 */
	driftShare: number;
}

export const DEFAULT_COVER_ROW: CoverRowParams = {
	coverWidth: 112,
	peek: 0.5,
	sideScale: 0.88,
	pixelsPerCover: 400,
	stiffness: 260,
	edgeResistance: 0.1,
	edgeStiffness: 900,
	driftShare: 0.18,
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
		// Nearer covers on top, changing only as a cover passes halfway, so the
		// stacking order isn't rebuilt every frame.
		zIndex: 1000 - Math.round(Math.abs(offset)),
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

/** The end cover a position has been pulled past, if it's past either end. */
export const pastEdge = (
	position: number,
	count: number,
): number | undefined => {
	const end = Math.max(0, count - 1);
	if (position < 0) return 0;
	if (position > end) return end;
	return undefined;
};

/** Fastest a bounce off an end starts, in covers per second. */
const MAX_BOUNCE = 12;

/**
 * Covers per second a bounce off an end starts with: the scrolling's own
 * speed, so a hard flick bounces further out than a gentle one, capped so
 * even the hardest only nudges out before the spring brings it back.
 */
export const bounceVelocity = (
	deltaPx: number,
	seconds: number,
	params: CoverRowParams,
): number => {
	const rate = deltaPx / params.pixelsPerCover / Math.max(0.004, seconds);
	return Math.max(-MAX_BOUNCE, Math.min(MAX_BOUNCE, rate));
};

export interface Spring {
	position: number;
	velocity: number;
}

/**
 * A critically damped spring towards `target`, solved exactly rather than
 * stepped: settles as fast as it can without a wobble, and stays steady
 * however long (or oddly timed) a frame is.
 */
export const springStep = (
	{ position, velocity }: Spring,
	target: number,
	seconds: number,
	stiffness: number,
): Spring => {
	const omega = Math.sqrt(stiffness);
	const t = Math.max(0, seconds);
	const offset = position - target;
	const carry = velocity + omega * offset;
	const decay = Math.exp(-omega * t);
	return {
		position: target + (offset + carry * t) * decay,
		velocity: (velocity - omega * carry * t) * decay,
	};
};

/** Close enough to rest that the spring can stop. */
export const atRest = ({ position, velocity }: Spring, target: number) =>
	Math.abs(target - position) < 0.001 && Math.abs(velocity) < 0.01;

/** How often a settle's path is sampled for the browser to animate. */
export const PATH_STEP_SECONDS = 1 / 120;

/**
 * The positions a settle passes through, one per `PATH_STEP_SECONDS`, from
 * where it starts until it comes to rest exactly on `target`: worked out up
 * front, so the browser can run the whole glide without waiting on scripts.
 */
export const springPath = (
	start: Spring,
	target: number,
	stiffness: number,
	maxSeconds = 3,
): number[] => {
	const path = [start.position];
	for (let t = PATH_STEP_SECONDS; t < maxSeconds; t += PATH_STEP_SECONDS) {
		const spring = springStep(start, target, t, stiffness);
		if (atRest(spring, target)) break;
		path.push(spring.position);
	}
	path.push(target);
	return path;
};

/**
 * Where a drag released with this velocity (covers per second) settles: the
 * cover its momentum would carry it to, like a flick on iOS.
 */
export const flingTarget = (
	position: number,
	velocity: number,
	count: number,
): number => nearestCover(position + velocity * 0.18, count);
