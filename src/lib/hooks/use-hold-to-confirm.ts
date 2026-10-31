import { useCallback, useEffect, useRef, useState } from "react";

/** How long to hold before the action happens. */
export const HOLD_MS = 900;
/** Let go sooner than this and it was a click, not a hold: explain. */
const QUICK_CLICK_MS = 250;
/** How long the "hold to…" hint stays up after a click. */
const HINT_MS = 1400;

export const HoldState = {
	idle: "idle",
	holding: "holding",
	held: "held",
} as const;
export type THoldState = (typeof HoldState)[keyof typeof HoldState];

/**
 * Press and hold to confirm a destructive action, with mouse, touch, pen or
 * Space/Enter. Letting go early cancels; a quick click shakes the button and
 * shows a hint instead of doing anything.
 */
export const useHoldToConfirm = ({
	onConfirm,
	holdMs = HOLD_MS,
	disabled = false,
}: {
	onConfirm: () => void;
	holdMs?: number;
	disabled?: boolean;
}) => {
	const [state, setState] = useState<THoldState>(HoldState.idle);
	// Bumped on each quick click, so the shake can replay.
	const [shakes, setShakes] = useState(0);
	const [hint, setHint] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const startedAt = useRef<number | undefined>(undefined);
	const onConfirmRef = useRef(onConfirm);
	onConfirmRef.current = onConfirm;

	useEffect(
		() => () => {
			clearTimeout(timer.current);
			clearTimeout(hintTimer.current);
		},
		[],
	);

	const start = useCallback(() => {
		if (disabled || startedAt.current !== undefined) return;
		startedAt.current = Date.now();
		setHint(false);
		setState(HoldState.holding);
		timer.current = setTimeout(() => {
			startedAt.current = undefined;
			setState(HoldState.held);
			onConfirmRef.current();
		}, holdMs);
	}, [disabled, holdMs]);

	const stop = useCallback(() => {
		const started = startedAt.current;
		if (started === undefined) return;
		startedAt.current = undefined;
		clearTimeout(timer.current);
		setState(HoldState.idle);
		if (Date.now() - started < QUICK_CLICK_MS) {
			setShakes((count) => count + 1);
			setHint(true);
			clearTimeout(hintTimer.current);
			hintTimer.current = setTimeout(() => setHint(false), HINT_MS);
		}
	}, []);

	return {
		state,
		shakes,
		hint,
		holdMs,
		handlers: {
			onPointerDown: (event: React.PointerEvent) => {
				if (event.button !== 0) return;
				event.preventDefault();
				start();
			},
			onPointerUp: stop,
			onPointerCancel: stop,
			onPointerLeave: stop,
			onKeyDown: (event: React.KeyboardEvent) => {
				if ((event.key !== " " && event.key !== "Enter") || event.repeat)
					return;
				event.preventDefault();
				start();
			},
			onKeyUp: (event: React.KeyboardEvent) => {
				if (event.key === " " || event.key === "Enter") stop();
			},
			onBlur: stop,
			// A long press would otherwise open the context menu part way.
			onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
		},
	};
};
