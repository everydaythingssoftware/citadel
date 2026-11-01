import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import {
	bounceVelocity,
	type CoverRowParams,
	coverStep,
	flingTarget,
	nearestCover,
	PATH_STEP_SECONDS,
	pastEdge,
	placeCover,
	type Spring,
	scrollBy,
	springPath,
	springStep,
} from "@/lib/cover-row";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** No wheel events for this long: the swipe and its momentum are over. */
const WHEEL_IDLE_MS = 70;
/**
 * Momentum fading below this share of the swipe's top speed is only drifting
 * on: settle now rather than creep the last few pixels.
 */
const DRIFT_SHARE = 0.18;
/**
 * Past an end, scrolling slower than this share of the gesture's top speed
 * is momentum running out (or the fingers stopping): bounce back now.
 */
const EDGE_LET_GO = 0.8;
/** A drag moving less than this (px) is a click. */
const CLICK_SLOP = 4;

const coversIn = (stage: HTMLElement) =>
	stage.querySelectorAll<HTMLElement>("[data-cover-index]");

/**
 * Drives a cover row with Cover Flow's physics: a fractional scroll
 * position that trackpad scrolling (with the system's own momentum),
 * dragging, and choosing a cover move; covers are placed straight from it
 * every frame, without React. The nearest cover is selected the moment it
 * reaches the middle, so whatever shows the selection never lags the covers.
 * Between gestures the position settles on a cover with a critically damped
 * spring.
 */
export const useCoverRow = ({
	stage,
	keys,
	index,
	onSelect,
	params,
}: {
	stage: RefObject<HTMLElement | null>;
	/** The covers' keys in order, to keep the stack still when one leaves. */
	keys: string[];
	index: number;
	onSelect: (index: number) => void;
	params: CoverRowParams;
}) => {
	const reduced = usePrefersReducedMotion();
	const position = useRef(index);
	const velocity = useRef(0);
	const selected = useRef(index);
	const frame = useRef(0);
	const width = useRef(0);
	const latest = useRef({ count: keys.length, params, onSelect, reduced });
	latest.current = { count: keys.length, params, onSelect, reduced };

	// Everything that moves the stack, built once from refs, so the event
	// listeners below never hold stale values.
	const { layout, draw, select, settleTo, hold, pause } = useMemo(() => {
		// What each cover was last given, so a frame only writes what changed:
		// unchanged and off-row covers cost the browser nothing.
		const drawn = new WeakMap<
			HTMLElement,
			{ transform: string; zIndex: string; hidden: boolean }
		>();
		const layout = () => {
			const element = stage.current;
			if (!element) return;
			if (width.current === 0) width.current = element.clientWidth;
			const rowWidth = width.current;
			const reach = rowWidth / 2 + latest.current.params.coverWidth;
			for (const cover of coversIn(element)) {
				const place = placeCover(
					Number(cover.dataset.coverIndex) - position.current,
					latest.current.params,
					rowWidth,
				);
				const was = drawn.get(cover);
				// Off the row entirely: hide it once and leave it be.
				const hidden = Math.abs(place.x) > reach;
				if (hidden) {
					if (!was?.hidden) cover.style.visibility = "hidden";
					drawn.set(cover, {
						transform: was?.transform ?? "",
						zIndex: was?.zIndex ?? "",
						hidden,
					});
					continue;
				}
				const transform = `translate3d(${place.x}px, 0, 0) scale(${place.scale})`;
				const zIndex = String(place.zIndex);
				if (was?.hidden !== false) cover.style.visibility = "";
				if (was?.transform !== transform) cover.style.transform = transform;
				if (was?.zIndex !== zIndex) cover.style.zIndex = zIndex;
				drawn.set(cover, { transform, zIndex, hidden });
			}
		};

		const show = (cover: HTMLElement) => {
			const was = drawn.get(cover);
			if (was?.hidden === false) return;
			cover.style.visibility = "";
			drawn.set(cover, {
				transform: was?.transform ?? "",
				zIndex: "",
				hidden: false,
			});
		};

		// Scrolling and dragging can fire several times a frame: draw once.
		let pending = 0;
		const draw = () => {
			if (pending) return;
			pending = requestAnimationFrame(() => {
				pending = 0;
				layout();
			});
		};

		const select = () => {
			const nearest = nearestCover(position.current, latest.current.count);
			if (nearest === selected.current) return;
			selected.current = nearest;
			latest.current.onSelect(nearest);
		};

		/**
		 * A settle under way: the browser animates each cover along the
		 * spring's precomputed path (off the main thread, so a busy page
		 * can't stutter it), while a light loop tracks the same exact spring
		 * only to keep the selection in step.
		 */
		let settling:
			| {
					start: Spring;
					target: number;
					stiffness: number;
					began: number;
					seconds: number;
					animations: Animation[];
			  }
			| undefined;

		const elapsed = (motion: NonNullable<typeof settling>) => {
			const time = motion.animations[0]?.currentTime;
			const ms =
				typeof time === "number" ? time : performance.now() - motion.began;
			return Math.min(motion.seconds, Math.max(0, ms / 1000));
		};

		/** Ends a settle where it has got to (or at its end), as plain styles. */
		const stop = (finished: boolean) => {
			const motion = settling;
			if (!motion) return;
			settling = undefined;
			cancelAnimationFrame(frame.current);
			const now = springStep(
				motion.start,
				motion.target,
				elapsed(motion),
				motion.stiffness,
			);
			position.current = finished ? motion.target : now.position;
			velocity.current = finished ? 0 : now.velocity;
			// Styles first, then drop the animations: no frame shows neither.
			layout();
			for (const animation of motion.animations) animation.cancel();
			select();
		};

		const follow = () => {
			const motion = settling;
			if (!motion) return;
			const seconds = elapsed(motion);
			if (seconds >= motion.seconds) {
				stop(true);
				return;
			}
			position.current = springStep(
				motion.start,
				motion.target,
				seconds,
				motion.stiffness,
			).position;
			select();
			frame.current = requestAnimationFrame(follow);
		};

		/** Glide to a cover; from past either end, snap back with the edge spring. */
		const settleTo = (cover: number) => {
			stop(false);
			const element = stage.current;
			const { params: current, count, reduced } = latest.current;
			const path = springPath(
				{ position: position.current, velocity: velocity.current },
				cover,
				pastEdge(position.current, count) === undefined
					? current.stiffness
					: current.edgeStiffness,
			);
			if (reduced || !element || path.length <= 2) {
				position.current = cover;
				velocity.current = 0;
				layout();
				select();
				return;
			}
			const rowWidth = width.current || element.clientWidth;
			const reach = rowWidth / 2 + current.coverWidth;
			const animations: Animation[] = [];
			const duration = (path.length - 1) * PATH_STEP_SECONDS * 1000;
			for (const node of coversIn(element)) {
				const at = Number(node.dataset.coverIndex);
				const places = path.map((p) => placeCover(at - p, current, rowWidth));
				// Covers that stay off the row through the whole glide sit it out.
				if (places.every((place) => Math.abs(place.x) > reach)) continue;
				const last = places.at(-1);
				if (last) node.style.zIndex = String(last.zIndex);
				show(node);
				animations.push(
					node.animate(
						places.map((place) => ({
							transform: `translate3d(${place.x}px, 0, 0) scale(${place.scale})`,
						})),
						{ duration, easing: "linear", fill: "forwards" },
					),
				);
			}
			settling = {
				start: { position: position.current, velocity: velocity.current },
				target: cover,
				stiffness:
					pastEdge(position.current, count) === undefined
						? current.stiffness
						: current.edgeStiffness,
				began: performance.now(),
				seconds: duration / 1000,
				animations,
			};
			frame.current = requestAnimationFrame(follow);
		};

		/** Freezes any settle where it has got to, keeping its speed. */
		const pause = () => stop(false);

		/** A new gesture takes over from any settle, exactly where it is. */
		const hold = () => {
			stop(false);
			velocity.current = 0;
		};
		return { layout, draw, select, settleTo, hold, pause };
	}, [stage]);

	// Place covers after every render (new ones included), and stop on unmount.
	useLayoutEffect(layout);
	// The row's width, kept rather than read every frame: reading it after
	// moving covers would make the browser restyle the row to answer.
	useLayoutEffect(() => {
		const element = stage.current;
		if (!element) return;
		width.current = element.clientWidth;
		const observer = new ResizeObserver(() => {
			width.current = element.clientWidth;
			layout();
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [stage, layout]);
	useEffect(() => hold, [hold]);

	// A cover leaving or arriving shifts the indices: keep what's on screen
	// where it was, then glide the chosen cover into the middle.
	const previousKeys = useRef(keys);
	useLayoutEffect(() => {
		const before = previousKeys.current;
		previousKeys.current = keys;
		if (before === keys || before.join("\n") === keys.join("\n")) return;
		// Where a settle had got to, in the old indices, before re-mapping.
		pause();
		const anchor = keys[index];
		const was = anchor === undefined ? -1 : before.indexOf(anchor);
		if (was >= 0) position.current = index - (was - position.current);
		selected.current = index;
		layout();
		settleTo(index);
	});

	// Chosen from outside (a click, the arrows, the pager): glide there.
	useEffect(() => {
		if (index === selected.current) return;
		selected.current = index;
		settleTo(index);
	});

	// Trackpad scrolling moves the stack directly, the system's momentum
	// included, so a flick spins through covers; when it stops, or has slowed
	// to a drift, the stack settles on the nearest cover.
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		let idle: ReturnType<typeof setTimeout> | undefined;
		let lastAt = 0;
		let speed = 0;
		let peak = 0;
		let drifting = false;
		// After bouncing off an end, the rest of the gesture pushing the same
		// way: ignored, so the bounce isn't held out there.
		let bounced = 0;
		const finish = () => {
			drifting = false;
			peak = 0;
			speed = 0;
			if (bounced !== 0) {
				bounced = 0;
				return;
			}
			settleTo(nearestCover(position.current, latest.current.count));
		};
		const onWheel = (event: WheelEvent) => {
			const delta =
				Math.abs(event.deltaX) > Math.abs(event.deltaY)
					? event.deltaX
					: event.shiftKey
						? event.deltaY
						: 0;
			if (delta === 0) return;
			event.preventDefault();
			const gap = event.timeStamp - lastAt;
			lastAt = event.timeStamp;
			clearTimeout(idle);
			idle = setTimeout(finish, WHEEL_IDLE_MS);
			if (bounced === Math.sign(delta)) return;
			bounced = 0;
			// The tail of a flick that's already settling: let it go.
			if (drifting && gap < WHEEL_IDLE_MS && Math.abs(delta) < 4) return;
			drifting = false;
			hold();
			const { count, params: current } = latest.current;
			position.current = scrollBy(position.current, delta, count, current);
			const rate = Math.abs(delta) / Math.max(4, gap);
			speed = speed * 0.6 + rate * 0.4;
			peak = Math.max(peak, speed);
			draw();
			select();
			// Past an end and no longer speeding up: like macOS, spring straight
			// back, carrying on outwards only as far as the bounce's own speed.
			const edge = pastEdge(position.current, count);
			if (edge !== undefined && speed < peak * EDGE_LET_GO) {
				bounced = Math.sign(delta);
				velocity.current = bounceVelocity(delta, gap / 1000, current);
				settleTo(edge);
				return;
			}
			if (peak > 0.5 && speed < peak * DRIFT_SHARE) {
				drifting = true;
				settleTo(nearestCover(position.current, count));
			}
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			clearTimeout(idle);
			element.removeEventListener("wheel", onWheel);
		};
	}, [stage, hold, draw, select, settleTo]);

	// Dragging with a mouse or finger moves the stack with the pointer; let
	// go and it carries on to where the flick's momentum would land.
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		let start: { x: number; position: number; id: number } | undefined;
		let dragging = false;
		let dragged = false;
		let lastX = 0;
		let lastAt = 0;
		let rate = 0;
		const step = () =>
			coverStep(latest.current.params, width.current || element.clientWidth);
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			start = {
				x: event.clientX,
				position: position.current,
				id: event.pointerId,
			};
			dragging = false;
			lastX = event.clientX;
			lastAt = event.timeStamp;
			rate = 0;
		};
		const onMove = (event: PointerEvent) => {
			if (!start || event.pointerId !== start.id) return;
			const moved = event.clientX - start.x;
			if (!dragging) {
				if (Math.abs(moved) < CLICK_SLOP) return;
				dragging = true;
				element.setPointerCapture(event.pointerId);
				hold();
			}
			const { count, params: current } = latest.current;
			const wanted = start.position - moved / step();
			const end = Math.max(0, count - 1);
			const clamped = Math.max(0, Math.min(end, wanted));
			position.current = clamped + (wanted - clamped) * current.edgeResistance;
			const seconds = Math.max(0.004, (event.timeStamp - lastAt) / 1000);
			rate = rate * 0.5 + (-(event.clientX - lastX) / step() / seconds) * 0.5;
			lastX = event.clientX;
			lastAt = event.timeStamp;
			draw();
			select();
		};
		const onUp = (event: PointerEvent) => {
			if (!start || event.pointerId !== start.id) return;
			start = undefined;
			if (!dragging) return;
			dragging = false;
			dragged = true;
			settleTo(flingTarget(position.current, rate, latest.current.count));
		};
		// A drag mustn't also count as clicking the cover it ended on.
		const onClick = (event: MouseEvent) => {
			if (!dragged) return;
			dragged = false;
			event.stopPropagation();
			event.preventDefault();
		};
		element.addEventListener("pointerdown", onDown);
		element.addEventListener("pointermove", onMove);
		element.addEventListener("pointerup", onUp);
		element.addEventListener("pointercancel", onUp);
		element.addEventListener("click", onClick, true);
		return () => {
			element.removeEventListener("pointerdown", onDown);
			element.removeEventListener("pointermove", onMove);
			element.removeEventListener("pointerup", onUp);
			element.removeEventListener("pointercancel", onUp);
			element.removeEventListener("click", onClick, true);
		};
	}, [stage, hold, draw, select, settleTo]);
};
