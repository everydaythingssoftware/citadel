import { type PointerEvent, useRef } from "react";

export interface SwipeHandlers {
	onPointerDown: (event: PointerEvent) => void;
	onPointerUp: (event: PointerEvent) => void;
	onPointerCancel: () => void;
}

/** How far a finger must travel sideways to count as a swipe. */
const THRESHOLD = 48;

/**
 * Horizontal swipe handlers for touch (and pen): a mostly sideways drag past
 * the threshold pages left or right. Mouse drags are ignored so text in the
 * swiped area stays selectable on desktop.
 */
export const useSwipe = ({
	onSwipeLeft,
	onSwipeRight,
}: {
	onSwipeLeft: () => void;
	onSwipeRight: () => void;
}): SwipeHandlers => {
	const start = useRef<{ x: number; y: number } | null>(null);
	return {
		onPointerDown: (event: PointerEvent) => {
			start.current =
				event.pointerType === "mouse"
					? null
					: { x: event.clientX, y: event.clientY };
		},
		onPointerUp: (event: PointerEvent) => {
			const from = start.current;
			start.current = null;
			if (!from) return;
			const dx = event.clientX - from.x;
			const dy = event.clientY - from.y;
			if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
			if (dx < 0) onSwipeLeft();
			else onSwipeRight();
		},
		onPointerCancel: () => {
			start.current = null;
		},
	};
};
