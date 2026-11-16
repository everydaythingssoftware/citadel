interface KeyPress {
	key: string;
	shiftKey: boolean;
}

interface AnchorRect {
	left: number;
	bottom: number;
}

/** The keyboard's way to a right-click menu: the Menu key, or Shift+F10. */
export const isContextMenuKey = ({ key, shiftKey }: KeyPress): boolean =>
	key === "ContextMenu" || (key === "F10" && shiftKey);

/**
 * An `openAt` event for a menu opened from the keyboard: it drops from the
 * focused control's bottom-left corner, where a pointer would have been.
 */
export const keyboardMenuAnchor = (
	event: KeyPress & { preventDefault(): void },
	rect: AnchorRect,
): { clientX: number; clientY: number; preventDefault(): void } | null =>
	isContextMenuKey(event)
		? {
				clientX: rect.left + 8,
				clientY: rect.bottom,
				preventDefault: () => event.preventDefault(),
			}
		: null;
