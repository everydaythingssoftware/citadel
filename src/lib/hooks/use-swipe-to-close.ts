import { type RefObject, useEffect } from "react";

interface SwipeToCloseOptions {
	/** The panel that slides out to the left. */
	panelRef: RefObject<HTMLElement | null>;
	/** The dimming layer beside the panel; a swipe can start on it too. */
	scrimRef: RefObject<HTMLElement | null>;
	enabled: boolean;
	onClose: () => void;
	reducedMotion: boolean;
}

/** Movement before a touch counts as a horizontal drag rather than a scroll. */
const AXIS_LOCK_PX = 8;
/** Past this share of its width, letting go closes the panel. */
const CLOSE_FRACTION = 1 / 3;
/** A leftward flick this fast (px/ms) closes it from any distance. */
const FLICK_VELOCITY = 0.4;
/** So does a short swipe: at least this far, this quickly. */
const QUICK_SWIPE = { px: 24, ms: 250 } as const;
const SETTLE_MS = 160;

/**
 * Lets a left-edge panel be swiped closed: it follows the finger leftward,
 * then either finishes sliding out and closes, or springs back.
 */
export const useSwipeToClose = ({
	panelRef,
	scrimRef,
	enabled,
	onClose,
	reducedMotion,
}: SwipeToCloseOptions) => {
	useEffect(() => {
		const panel = panelRef.current;
		const scrim = scrimRef.current;
		if (!enabled || !panel) return;

		let startX = 0;
		let startY = 0;
		let axis: "horizontal" | "vertical" | null = null;
		let offset = 0;
		let lastX = 0;
		let lastTime = 0;
		let startTime = 0;
		let velocity = 0;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;

		const place = (x: number, animate: boolean) => {
			const transition =
				animate && !reducedMotion ? `${SETTLE_MS}ms ease-out` : "none";
			panel.style.transition = `transform ${transition}`;
			panel.style.transform = x === 0 ? "" : `translateX(${x}px)`;
			if (scrim) {
				scrim.style.transition = `opacity ${transition}`;
				scrim.style.opacity = String(1 + x / panel.offsetWidth);
			}
		};
		const reset = () => {
			panel.style.transition = "";
			panel.style.transform = "";
			if (scrim) {
				scrim.style.transition = "";
				scrim.style.opacity = "";
			}
		};

		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch || event.touches.length > 1) return;
			clearTimeout(settleTimer);
			startX = lastX = touch.clientX;
			startY = touch.clientY;
			lastTime = startTime = event.timeStamp;
			axis = null;
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
			if (elapsed > 0) velocity = (touch.clientX - lastX) / elapsed;
			lastX = touch.clientX;
			lastTime = event.timeStamp;
			offset = Math.min(0, dx);
			place(offset, false);
		};

		const onEnd = (event: TouchEvent) => {
			if (axis !== "horizontal") return;
			axis = null;
			const width = panel.offsetWidth;
			const quickSwipe =
				offset <= -QUICK_SWIPE.px &&
				event.timeStamp - startTime < QUICK_SWIPE.ms;
			if (
				offset < -width * CLOSE_FRACTION ||
				velocity < -FLICK_VELOCITY ||
				quickSwipe
			) {
				place(-width, true);
				settleTimer = setTimeout(
					() => {
						reset();
						onClose();
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
	}, [enabled, panelRef, scrimRef, onClose, reducedMotion]);
};
