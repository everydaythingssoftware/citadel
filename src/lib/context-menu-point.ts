export interface ContextMenuTrigger {
	clientX: number;
	clientY: number;
	button: number;
	preventDefault(): void;
}

export interface AnchorRect {
	left: number;
	bottom: number;
}

/**
 * The Menu key and Shift-F10 open a context menu with no pointer position
 * (0, 0, or the main button): open it under the focused thing instead.
 */
export const fromKeyboard = (event: ContextMenuTrigger): boolean =>
	event.button !== 2 || (event.clientX === 0 && event.clientY === 0);

export const contextMenuPoint = (
	event: ContextMenuTrigger,
	anchor: AnchorRect | null,
): ContextMenuTrigger =>
	fromKeyboard(event) && anchor !== null
		? {
				clientX: anchor.left + 8,
				clientY: anchor.bottom,
				button: event.button,
				preventDefault: () => event.preventDefault(),
			}
		: event;
