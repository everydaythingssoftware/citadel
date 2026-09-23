import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ContextMenu.module.css";
import { POPOVER_ATTRIBUTE } from "./popover-interop";

export interface ContextMenuItem {
	id: string;
	label: string;
	onSelect: () => void;
}

/** Anchored at viewport coordinates; null closes the menu. */
export interface ContextMenuState {
	x: number;
	y: number;
	items: ContextMenuItem[];
}

export interface ContextMenuProps {
	menu: ContextMenuState | null;
	/** Element focus returns to on Escape or item select (not outside-click). */
	returnFocusRef?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

/**
 * Body-portal context menu (right-click / Menu-key style): fixed positioning
 * clamped to the viewport, Apple-style focus on the first item on open,
 * Escape/outside-close, and arrow/Home/End navigation. Same popover treatment
 * as the LibraryPicker menu (POPOVER_ATTRIBUTE keeps dialogs from closing on
 * clicks inside it).
 */
export const ContextMenu = ({
	menu,
	returnFocusRef,
	onClose,
}: ContextMenuProps) => {
	const menuRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{
		left: number;
		top: number;
	} | null>(null);

	// Measured after render, before paint, so the clamped position lands with
	// no flicker; the menu renders offscreen until then.
	useLayoutEffect(() => {
		if (!menu) {
			setPosition(null);
			return;
		}
		const rect = menuRef.current?.getBoundingClientRect();
		if (!rect) return;
		const left = Math.max(
			VIEWPORT_MARGIN,
			Math.min(menu.x, window.innerWidth - rect.width - VIEWPORT_MARGIN),
		);
		const top = Math.max(
			VIEWPORT_MARGIN,
			Math.min(menu.y, window.innerHeight - rect.height - VIEWPORT_MARGIN),
		);
		setPosition({ left, top });
	}, [menu]);

	useLayoutEffect(() => {
		if (!menu || !position) return;
		menuRef.current
			?.querySelector<HTMLButtonElement>('[role="menuitem"]')
			?.focus();
	}, [menu, position]);

	useEffect(() => {
		if (!menu) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (menuRef.current?.contains(target)) return;
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			onClose();
			returnFocusRef?.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [menu, onClose, returnFocusRef]);

	if (!menu) return null;

	const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const items = Array.from(
			menuRef.current?.querySelectorAll<HTMLButtonElement>(
				'[role="menuitem"]',
			) ?? [],
		);
		if (items.length === 0) return;
		const activeElement = document.activeElement;
		const current =
			activeElement instanceof HTMLButtonElement
				? items.indexOf(activeElement)
				: -1;
		let next: number;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				next = current + 1;
				break;
			case "ArrowUp":
				event.preventDefault();
				next = current - 1;
				break;
			case "Home":
				event.preventDefault();
				next = 0;
				break;
			case "End":
				event.preventDefault();
				next = items.length - 1;
				break;
			default:
				return;
		}
		if (next < 0) next = items.length - 1;
		if (next >= items.length) next = 0;
		items[next]?.focus();
	};

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label="Library actions"
			className={styles.menu}
			{...{ [POPOVER_ATTRIBUTE]: "" }}
			style={{
				left: position?.left ?? -9999,
				top: position?.top ?? -9999,
			}}
			onKeyDown={onMenuKeyDown}
		>
			{menu.items.map((item) => (
				<button
					key={item.id}
					type="button"
					role="menuitem"
					className={styles.menuItem}
					onClick={() => {
						onClose();
						returnFocusRef?.current?.focus();
						item.onSelect();
					}}
				>
					{item.label}
				</button>
			))}
		</div>,
		document.body,
	);
};
