import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import {
	atRest,
	type CoverRowParams,
	coverStep,
	flingTarget,
	nearestCover,
	placeCover,
	scrollBy,
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
	const target = useRef<number | undefined>(undefined);
	const selected = useRef(index);
	const frame = useRef(0);
	const latest = useRef({ count: keys.length, params, onSelect, reduced });
	latest.current = { count: keys.length, params, onSelect, reduced };

	// Everything that moves the stack, built once from refs, so the event
	// listeners below never hold stale values.
	const { layout, select, settleTo, hold } = useMemo(() => {
		const layout = () => {
			const element = stage.current;
			if (!element) return;
			const width = element.clientWidth;
			const reach = width / 2 + latest.current.params.coverWidth;
			for (const cover of coversIn(element)) {
				const place = placeCover(
					Number(cover.dataset.coverIndex) - position.current,
					latest.current.params,
					width,
				);
				cover.style.transform = `translate3d(${place.x}px, 0, 0) scale(${place.scale})`;
				cover.style.zIndex = String(place.zIndex);
				// Off the row entirely: nothing to draw.
				cover.style.visibility = Math.abs(place.x) > reach ? "hidden" : "";
			}
		};

		const select = () => {
			const nearest = nearestCover(position.current, latest.current.count);
			if (nearest === selected.current) return;
			selected.current = nearest;
			latest.current.onSelect(nearest);
		};

		const tick = (last: number) => (now: number) => {
			const settling = target.current;
			if (settling === undefined) return;
			const spring = springStep(
				{ position: position.current, velocity: velocity.current },
				settling,
				Math.min(0.05, (now - last) / 1000),
				latest.current.params.stiffness,
			);
			position.current = spring.position;
			velocity.current = spring.velocity;
			if (atRest(spring, settling)) {
				position.current = settling;
				velocity.current = 0;
				target.current = undefined;
			}
			layout();
			select();
			if (target.current !== undefined)
				frame.current = requestAnimationFrame(tick(now));
		};

		const settleTo = (cover: number) => {
			target.current = cover;
			cancelAnimationFrame(frame.current);
			if (latest.current.reduced) {
				position.current = cover;
				velocity.current = 0;
				target.current = undefined;
				layout();
				select();
				return;
			}
			frame.current = requestAnimationFrame(tick(performance.now()));
		};

		const hold = () => {
			target.current = undefined;
			cancelAnimationFrame(frame.current);
		};
		return { layout, select, settleTo, hold };
	}, [stage]);

	// Place covers after every render (new ones included), and stop on unmount.
	useLayoutEffect(layout);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);

	// A cover leaving or arriving shifts the indices: keep what's on screen
	// where it was, then glide the chosen cover into the middle.
	const previousKeys = useRef(keys);
	useLayoutEffect(() => {
		const before = previousKeys.current;
		previousKeys.current = keys;
		if (before === keys || before.join("\n") === keys.join("\n")) return;
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
		const finish = () => {
			drifting = false;
			peak = 0;
			speed = 0;
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
			// The tail of a flick that's already settling: let it go.
			if (drifting && gap < WHEEL_IDLE_MS && Math.abs(delta) < 4) return;
			drifting = false;
			hold();
			const { count, params: current } = latest.current;
			position.current = scrollBy(position.current, delta, count, current);
			const rate = Math.abs(delta) / Math.max(4, gap);
			speed = speed * 0.6 + rate * 0.4;
			peak = Math.max(peak, speed);
			layout();
			select();
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
	}, [stage, hold, layout, select, settleTo]);

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
		const step = () => coverStep(latest.current.params, element.clientWidth);
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
			layout();
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
	}, [stage, hold, layout, select, settleTo]);
};
