import { useCallback, useMemo, useRef, useState } from "react";
import {
	type ContextMenuEntry,
	type ContextMenuState,
	opensMenuFromButton,
	toggleMenu,
} from "@/lib/context-menu";
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

/** The props of a button that opens the menu under itself. */
export interface ContextMenuButton {
	"aria-haspopup": "menu";
	/**
	 * True while the menu with this label is open. One controller can hold the
	 * menus of many controls.
	 */
	"aria-expanded": boolean;
	/** Opens the menu, or closes it when this button opened it. */
	onClick: (event: React.MouseEvent<HTMLElement>) => void;
	/** ArrowDown opens the menu. Enter and Space click the button. */
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
	/**
	 * Props for a button that opens the menu under itself. A second click
	 * closes the menu. Focus returns to `returnFocus`, or to the button.
	 */
	menuButton(
		items: ContextMenuEntry[],
		label: string,
		options?: { returnFocus?: React.RefObject<HTMLElement | null> },
	): ContextMenuButton;
	/**
	 * The control the menu was last opened from, or the `returnFocus` of
	 * `menuButton`; pass to ContextMenu.
	 */
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
 * the control, or `{...menu.menuButton(items, "Search scope")}` on a menu
 * button, and `<ContextMenu menu={menu.menu} returnFocusRef=
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
	const menuButton = useCallback(
		(
			items: ContextMenuEntry[],
			label: string,
			options?: { returnFocus?: React.RefObject<HTMLElement | null> },
		): ContextMenuButton => {
			const under = (button: HTMLElement): ContextMenuState => {
				returnFocusRef.current = options?.returnFocus?.current ?? button;
				const rect = button.getBoundingClientRect();
				return { x: rect.left, y: rect.bottom, items, label, anchor: button };
			};
			return {
				"aria-haspopup": "menu",
				"aria-expanded": menu?.label === label,
				onClick: (event) => {
					const opening = under(event.currentTarget);
					setMenu((open) => toggleMenu(open, opening));
				},
				onKeyDown: (event) => {
					if (!opensMenuFromButton(event.key)) return;
					event.preventDefault();
					setMenu(under(event.currentTarget));
				},
			};
		},
		[menu],
	);
	const close = useCallback(() => setMenu(null), []);
	return useMemo(
		() => ({ menu, openAt, target, menuButton, returnFocusRef, close }),
		[menu, openAt, target, menuButton, close],
	);
};
