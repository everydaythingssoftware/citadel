import { useEffect, useRef, useState } from "react";

interface SwipeToCloseOptions {
	/** The screen edge the panel is attached to, and slides out through. */
	edge: "left" | "right";
	enabled: boolean;
	onClose: () => void;
	reducedMotion: boolean;
}

interface SwipeToClose {
	/** Attach to the panel that slides out toward its edge. */
	panelRef: (element: HTMLElement | null) => void;
	/** Attach to the dimming layer beside it; a swipe can start there too. */
	scrimRef: (element: HTMLElement | null) => void;
}

/** Movement before a touch counts as a horizontal drag rather than a scroll. */
const AXIS_LOCK_PX = 8;
/** Past this share of its width, letting go closes the panel. */
const CLOSE_FRACTION = 1 / 3;
/** A flick toward the edge this fast (px/ms) closes it from any distance. */
const FLICK_VELOCITY = 0.4;
/** So does a short swipe: at least this far, this quickly. */
const QUICK_SWIPE = { px: 24, ms: 250 } as const;
const SETTLE_MS = 160;

/** A touch inside something that scrolls sideways belongs to that scroller. */
const startsInHorizontalScroller = (
	target: EventTarget | null,
	panel: HTMLElement,
) => {
	for (
		let node = target instanceof Element ? target : null;
		node && node !== panel;
		node = node.parentElement
	) {
		const { overflowX } = getComputedStyle(node);
		if (
			(overflowX === "auto" || overflowX === "scroll") &&
			node.scrollWidth > node.clientWidth
		)
			return true;
	}
	return false;
};

/**
 * Lets an edge panel be swiped closed: it follows the finger toward its
 * edge, then either finishes sliding out and closes, or springs back.
 */
export const useSwipeToClose = ({
	edge,
	enabled,
	onClose,
	reducedMotion,
}: SwipeToCloseOptions): SwipeToClose => {
	// Elements, not ref objects: a panel that mounts after `enabled` turns on
	// (a portal, a dialog) still gets the gesture.
	const [panel, panelRef] = useState<HTMLElement | null>(null);
	const [scrim, scrimRef] = useState<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!enabled || !panel) return;
		// Distances are measured toward the edge: positive closes.
		const towardEdge = edge === "left" ? -1 : 1;

		let startX = 0;
		let startY = 0;
		let axis: "horizontal" | "vertical" | null = null;
		let offset = 0;
		let lastX = 0;
		let lastTime = 0;
		let startTime = 0;
		let velocity = 0;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;

		const place = (distance: number, animate: boolean) => {
			const transition =
				animate && !reducedMotion ? `${SETTLE_MS}ms ease-out` : "none";
			panel.style.transition = `transform ${transition}`;
			panel.style.transform =
				distance === 0 ? "" : `translateX(${distance * towardEdge}px)`;
			if (scrim) {
				scrim.style.transition = `opacity ${transition}`;
				scrim.style.opacity = String(1 - distance / panel.offsetWidth);
			}
		};
		const reset = () => {
			for (const element of [panel, scrim]) {
				if (!element) continue;
				element.style.transition = "";
				element.style.transform = "";
				element.style.opacity = "";
				element.style.animation = "";
			}
		};

		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch || event.touches.length > 1) return;
			clearTimeout(settleTimer);
			startX = lastX = touch.clientX;
			startY = touch.clientY;
			lastTime = startTime = event.timeStamp;
			axis = startsInHorizontalScroller(event.target, panel)
				? "vertical"
				: null;
			offset = 0;
			velocity = 0;
		};

		const onMove = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch || axis === "vertical") return;
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;
			if (axis === null) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
				axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
				if (axis === "vertical") return;
			}
			// A horizontal drag moves the panel, not the page under it.
			event.preventDefault();
			const elapsed = event.timeStamp - lastTime;
			if (elapsed > 0)
				velocity = ((touch.clientX - lastX) * towardEdge) / elapsed;
			lastX = touch.clientX;
			lastTime = event.timeStamp;
			offset = Math.max(0, dx * towardEdge);
			place(offset, false);
		};

		const onEnd = (event: TouchEvent) => {
			if (axis !== "horizontal") return;
			axis = null;
			const width = panel.offsetWidth;
			const quickSwipe =
				offset >= QUICK_SWIPE.px &&
				event.timeStamp - startTime < QUICK_SWIPE.ms;
			if (
				offset > width * CLOSE_FRACTION ||
				velocity > FLICK_VELOCITY ||
				quickSwipe
			) {
				place(width, true);
				settleTimer = setTimeout(
					() => {
						// The panel is already out: its own closing animation would
						// start it back at rest first.
						panel.style.animation = "none";
						if (scrim) scrim.style.animation = "none";
						onCloseRef.current();
					},
					reducedMotion ? 0 : SETTLE_MS,
				);
			} else {
				place(0, true);
			}
		};

		const targets = scrim ? [panel, scrim] : [panel];
		for (const target of targets) {
			target.addEventListener("touchstart", onStart, { passive: true });
			target.addEventListener("touchmove", onMove, { passive: false });
			target.addEventListener("touchend", onEnd);
			target.addEventListener("touchcancel", onEnd);
		}
		return () => {
			clearTimeout(settleTimer);
			for (const target of targets) {
				target.removeEventListener("touchstart", onStart);
				target.removeEventListener("touchmove", onMove);
				target.removeEventListener("touchend", onEnd);
				target.removeEventListener("touchcancel", onEnd);
			}
			reset();
		};
	}, [enabled, panel, scrim, edge, reducedMotion]);

	return { panelRef, scrimRef };
};
