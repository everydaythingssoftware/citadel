import { useCallback, useMemo, useState } from "react";
import type { ContextMenuEntry, ContextMenuState } from "@/lib/context-menu";

export interface ContextMenuOpenEvent {
	clientX: number;
	clientY: number;
	preventDefault(): void;
}

export interface ContextMenuController {
	menu: ContextMenuState | null;
	openAt(
		event: ContextMenuOpenEvent,
		items: ContextMenuEntry[],
		label?: string,
	): void;
	close(): void;
}

/**
 * State for one ContextMenu: `onContextMenu={(e) => menu.openAt(e, items,
 * "Book actions")}` on the target, `<ContextMenu menu={menu.menu}
 * onClose={menu.close} />` beside it.
 */
export const useContextMenu = (): ContextMenuController => {
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
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
	const close = useCallback(() => setMenu(null), []);
	return useMemo(() => ({ menu, openAt, close }), [menu, openAt, close]);
};
