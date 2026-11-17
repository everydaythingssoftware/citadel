import { useCallback, useMemo, useRef, useState } from "react";
import type { ContextMenuEntry, ContextMenuState } from "@/lib/context-menu";
import { none, type Option, some } from "@/lib/option";

export interface ContextMenuOpenEvent {
	clientX: number;
	clientY: number;
	preventDefault(): void;
}

/** Right-click, the Menu key and Shift+F10 open the menu from this control. */
export interface ContextMenuTarget {
	onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export interface ContextMenuController {
	menu: ContextMenuState | null;
	openAt(
		event: ContextMenuOpenEvent,
		items: ContextMenuEntry[],
		label?: string,
	): void;
	target(items: ContextMenuEntry[], label: string): ContextMenuTarget;
	/** The control the menu was last opened from; pass to ContextMenu. */
	returnFocusRef: React.RefObject<HTMLElement | null>;
	close(): void;
}

/**
 * A menu opened from the keyboard drops from the focused control's
 * bottom-left corner, where a pointer would have been.
 */
export const keyboardMenuEvent = (
	event: { key: string; shiftKey: boolean; preventDefault(): void },
	rect: { left: number; bottom: number },
): Option<ContextMenuOpenEvent> =>
	event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)
		? some({
				clientX: rect.left + 8,
				clientY: rect.bottom,
				preventDefault: () => event.preventDefault(),
			})
		: none();

/**
 * State for one ContextMenu: `{...menu.target(items, "Book actions")}` on
 * the control, `<ContextMenu menu={menu.menu} returnFocusRef=
 * {menu.returnFocusRef} onClose={menu.close} />` beside it.
 */
export const useContextMenu = (): ContextMenuController => {
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const openAt = useCallback(
		(
			event: ContextMenuOpenEvent,
			items: ContextMenuEntry[],
			label?: string,
		) => {
			event.preventDefault();
			setMenu({ x: event.clientX, y: event.clientY, items, label });
		},
		[],
	);
	const target = useCallback(
		(items: ContextMenuEntry[], label: string): ContextMenuTarget => ({
			onContextMenu: (event) => {
				returnFocusRef.current = event.currentTarget;
				openAt(event, items, label);
			},
			onKeyDown: (event) => {
				const opened = keyboardMenuEvent(
					event,
					event.currentTarget.getBoundingClientRect(),
				);
				if (!opened.isSome) return;
				returnFocusRef.current = event.currentTarget;
				openAt(opened.value, items, label);
			},
		}),
		[openAt],
	);
	const close = useCallback(() => setMenu(null), []);
	return useMemo(
		() => ({ menu, openAt, target, returnFocusRef, close }),
		[menu, openAt, target, close],
	);
};
