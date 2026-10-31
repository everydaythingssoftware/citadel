/** A rectangle's vertical edges and horizontal extent, in viewport pixels. */
export interface FieldRect {
	top: number;
	bottom: number;
	left: number;
	width: number;
}

/** Where a completion list sits: under its field, or above it. */
export interface ListPlacement {
	left: number;
	/** The edge touching the field: the list's top, or its bottom when above. */
	top: number;
	width: number;
	maxHeight: number;
	above: boolean;
}

const GAP = 4;
const MARGIN = 8;

/**
 * Places a field's completion list inside the visible part of the screen:
 * under the field when it fits (or has more room), otherwise above, never
 * past either edge. With too little room on both sides, or the field out of
 * view, there's no list at all rather than a sliver.
 */
export const placeList = (
	field: FieldRect,
	visible: { top: number; bottom: number },
	{
		preferred = 180,
		minimum = 64,
	}: { preferred?: number; minimum?: number } = {},
): ListPlacement | undefined => {
	if (field.bottom <= visible.top || field.top >= visible.bottom)
		return undefined;
	const below = visible.bottom - field.bottom - GAP - MARGIN;
	const aboveSpace = field.top - visible.top - GAP - MARGIN;
	const above = below < preferred && aboveSpace > below;
	const space = above ? aboveSpace : below;
	if (space < minimum) return undefined;
	return {
		left: field.left,
		top: above ? field.top - GAP : field.bottom + GAP,
		width: field.width,
		maxHeight: Math.min(preferred, space),
		above,
	};
};

/**
 * The visible part of the page in layout-viewport coordinates (what
 * getBoundingClientRect and position: fixed use). On iOS the on-screen
 * keyboard shrinks only the visual viewport.
 */
export const visibleArea = (): { top: number; bottom: number } => {
	const viewport = window.visualViewport;
	if (!viewport) return { top: 0, bottom: window.innerHeight };
	return {
		top: viewport.offsetTop,
		bottom: viewport.offsetTop + viewport.height,
	};
};
