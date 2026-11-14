import { useCallback, useRef, useState } from "react";

export interface EdgeResizeHandleProps {
	role: "separator";
	tabIndex: 0;
	"aria-orientation": "vertical";
	"aria-label": string;
	"aria-valuemin": number;
	"aria-valuemax": number;
	"aria-valuenow": number;
	onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
	onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
	onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
	onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
	onDoubleClick: () => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export interface EdgeResize {
	width: number;
	/** A drag is under way; width changes then should not animate. */
	resizing: boolean;
	handleProps: EdgeResizeHandleProps;
}

export const ResizeEdge = {
	/** The handle is the panel's right edge (a sidebar): dragging right widens it. */
	right: "right",
	/** The handle is the panel's left edge (an inspector): dragging left widens it. */
	left: "left",
} as const;

export type ResizeEdge = (typeof ResizeEdge)[keyof typeof ResizeEdge];

export interface EdgeResizeOptions {
	width: number;
	min: number;
	max: number;
	/** Arrow keys move the edge this far; Shift moves it five times as far. */
	step: number;
	edge: ResizeEdge;
	label: string;
	setWidth: (width: number) => void;
	resetWidth: () => void;
}

/** How far a pointer at `x` puts the edge from where the drag began. */
export const draggedWidth = (
	start: { x: number; width: number },
	x: number,
	edge: ResizeEdge,
): number =>
	edge === ResizeEdge.right
		? start.width + x - start.x
		: start.width - (x - start.x);

/** The width an arrow, Home or End key asks for, or null for other keys. */
export const keyedWidth = (
	key: string,
	shiftKey: boolean,
	{ width, min, max, step, edge }: EdgeResizeOptions,
): number | null => {
	const grow = edge === ResizeEdge.right ? "ArrowRight" : "ArrowLeft";
	const shrink = edge === ResizeEdge.right ? "ArrowLeft" : "ArrowRight";
	const delta = shiftKey ? step * 5 : step;
	if (key === grow) return width + delta;
	if (key === shrink) return width - delta;
	if (key === "Home") return min;
	if (key === "End") return max;
	return null;
};

/**
 * A panel's resizable edge: drag to resize, double-click to reset, and
 * arrow keys (Home/End for the limits) when the handle has focus.
 */
export const useEdgeResize = (options: EdgeResizeOptions): EdgeResize => {
	const { width, min, max, edge, label, setWidth, resetWidth } = options;
	const [resizing, setResizing] = useState(false);
	const start = useRef<{ x: number; width: number } | null>(null);

	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			start.current = { x: event.clientX, width };
			setResizing(true);
		},
		[width],
	);

	const onPointerMove = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			if (!start.current) return;
			setWidth(draggedWidth(start.current, event.clientX, edge));
		},
		[setWidth, edge],
	);

	const end = useCallback((event: React.PointerEvent<HTMLElement>) => {
		if (!start.current) return;
		start.current = null;
		setResizing(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	}, []);

	const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		const next = keyedWidth(event.key, event.shiftKey, options);
		if (next === null) return;
		event.preventDefault();
		setWidth(next);
	};

	return {
		width,
		resizing,
		handleProps: {
			role: "separator",
			tabIndex: 0,
			"aria-orientation": "vertical",
			"aria-label": label,
			"aria-valuemin": min,
			"aria-valuemax": max,
			"aria-valuenow": width,
			onPointerDown,
			onPointerMove,
			onPointerUp: end,
			onPointerCancel: end,
			onDoubleClick: resetWidth,
			onKeyDown,
		},
	};
};
