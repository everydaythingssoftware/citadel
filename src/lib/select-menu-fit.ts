/** Radix Select keeps its item-aligned menu this far from the window edges. */
export const MENU_MARGIN_PX = 10;

export interface MenuFitInput {
	/**
	 * How tall the menu may grow: from its top edge down to the window's
	 * margin, or for a menu pinned to its bottom edge, from there up.
	 */
	room: number;
	/** The menu's height now. */
	height: number;
	/** The height it needs to show every item without scrolling. */
	fullHeight: number;
	/** How far its list is scrolled. */
	scrollTop: number;
}

/**
 * The height an open pop-up menu should grow to so every item shows, or
 * null when it already does or can't.
 *
 * Radix lines the chosen item up with the button, shortening the menu and
 * scrolling its list when that would cross the window's edge, and relies on
 * a min-height to undo that for short lists. In the macOS app the menu kept
 * the shortened size or the scroll: a four-item menu opened near the top
 * with "Author (Z–A)" chosen showed three items and a scroll arrow. A short
 * list that fits should simply show whole.
 */
export const unclippedMenuHeight = ({
	room,
	height,
	fullHeight,
	scrollTop,
}: MenuFitInput): number | null => {
	const clipped = height + 0.5 < fullHeight || scrollTop > 0;
	if (!clipped) return null;
	return fullHeight <= room ? Math.ceil(fullHeight) : null;
};

/** How far a menu may grow, from where Radix pinned it. */
export const menuRoom = ({
	top,
	bottom,
	viewportHeight,
	pinnedToBottom,
}: {
	top: number;
	bottom: number;
	viewportHeight: number;
	pinnedToBottom: boolean;
}): number =>
	pinnedToBottom
		? bottom - MENU_MARGIN_PX
		: viewportHeight - MENU_MARGIN_PX - top;
