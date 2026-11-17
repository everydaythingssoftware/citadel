import { useCallback, useRef, useState } from "react";
import { none, type Option, some } from "@/lib/option";
import { maxWidthWithin, type PanelWidthStore } from "@/stores/panel-width";

/** Arrow keys move the edge this far; Shift moves it five times as far. */
const KEY_STEP = 10;

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

/** How far a pointer at `x` puts the edge from where the drag began. */
export const draggedWidth = (
	start: { x: number; width: number },
	x: number,
	edge: ResizeEdge,
): number =>
	edge === ResizeEdge.right
		? start.width + x - start.x
		: start.width - (x - start.x);

/** The width an arrow, Home or End key asks for. */
export const keyedWidth = (
	key: string,
	shiftKey: boolean,
	{
		width,
		min,
		max,
		edge,
	}: { width: number; min: number; max: number; edge: ResizeEdge },
): Option<number> => {
	const grow = edge === ResizeEdge.right ? "ArrowRight" : "ArrowLeft";
	const shrink = edge === ResizeEdge.right ? "ArrowLeft" : "ArrowRight";
	const delta = shiftKey ? KEY_STEP * 5 : KEY_STEP;
	if (key === grow) return some(width + delta);
	if (key === shrink) return some(width - delta);
	if (key === "Home") return some(min);
	if (key === "End") return some(max);
	return none();
};

export interface EdgeResizeOptions {
	edge: ResizeEdge;
	label: string;
	/** What the panel's `maxShare` is a share of, once known. */
	containerWidth: Option<number>;
}

/**
 * A panel's resizable edge: drag to resize, double-click to reset, and
 * arrow keys (Home/End for the limits) when the handle has focus. The width
 * shown never exceeds the panel's share of its container; a drag past that
 * stops there, so the stored width is always one the user saw.
 */
export const useEdgeResize = (
	store: PanelWidthStore,
	{ edge, label, containerWidth }: EdgeResizeOptions,
): EdgeResize => {
	const stored = store((s) => s.width);
	const { setWidth: setStored, saveWidth, resetWidth } = store.getState();
	const { min } = store.limits;
	const max = containerWidth.isSome
		? maxWidthWithin(store.limits, containerWidth.value)
		: store.limits.max;
	const width = Math.min(stored, max);
	const setWidth = (next: number) => setStored(Math.min(next, max));

	const [resizing, setResizing] = useState(false);
	const start = useRef<{ x: number; width: number } | null>(null);

	const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		start.current = { x: event.clientX, width };
		setResizing(true);
	};

	const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
		if (!start.current) return;
		setWidth(draggedWidth(start.current, event.clientX, edge));
	};

	const end = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			if (!start.current) return;
			start.current = null;
			setResizing(false);
			saveWidth();
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
		},
		[saveWidth],
	);

	const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		const next = keyedWidth(event.key, event.shiftKey, {
			width,
			min,
			max,
			edge,
		});
		if (!next.isSome) return;
		event.preventDefault();
		setWidth(next.value);
		saveWidth();
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
