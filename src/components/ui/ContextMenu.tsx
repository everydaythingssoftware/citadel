import { createPortal } from "react-dom";
import type { ContextMenuEntry, ContextMenuState } from "@/lib/context-menu";
import { isMenuItem } from "@/lib/context-menu";
import { useContextMenuSurface } from "@/lib/hooks/use-context-menu-surface";
import styles from "./ContextMenu.module.css";
import { POPOVER_ATTRIBUTE } from "./popover-interop";

export type { ContextMenuEntry, ContextMenuState };

export interface ContextMenuProps {
	menu: ContextMenuState | null;
	/** Element focus returns to on Escape or item select (not outside-click). */
	returnFocusRef?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
}

/**
 * A right-click menu, platform-adaptive through `data-platform`: the glass
 * NSMenu look on macOS, a plain opaque one elsewhere. Items are title case;
 * groups are split by separators; one that opens a dialog ends in "…".
 * Body portal with POPOVER_ATTRIBUTE, so dialogs don't treat clicks in it
 * as outside clicks.
 */
export const ContextMenu = ({
	menu,
	returnFocusRef,
	onClose,
}: ContextMenuProps) => {
	const surface = useContextMenuSurface({ menu, returnFocusRef, onClose });
	const { shown, entries, highlighted, position } = surface;
	if (!shown) return null;

	const highlightedEntry =
		highlighted === null ? undefined : entries[highlighted];

	return createPortal(
		<div
			ref={surface.menuRef}
			role="menu"
			aria-label={shown.label}
			aria-activedescendant={
				highlightedEntry ? surface.itemDomId(highlightedEntry) : undefined
			}
			tabIndex={-1}
			className={styles.menu}
			data-closing={surface.closing || undefined}
			{...{ [POPOVER_ATTRIBUTE]: "" }}
			style={{
				left: position?.left ?? -9999,
				top: position?.top ?? -9999,
				visibility: position ? undefined : "hidden",
			}}
			onKeyDown={surface.onMenuKeyDown}
			onPointerLeave={surface.onMenuPointerLeave}
			onContextMenu={(event) => event.preventDefault()}
		>
			{entries.map((entry, index) =>
				isMenuItem(entry) ? (
					// Never focused itself: the menu keeps focus and points here
					// with aria-activedescendant.
					<button
						key={entry.id}
						type="button"
						tabIndex={-1}
						id={surface.itemDomId(entry)}
						role="menuitem"
						aria-disabled={entry.disabled || undefined}
						aria-keyshortcuts={entry.keyShortcuts}
						className={styles.item}
						data-highlighted={index === highlighted || undefined}
						data-destructive={entry.destructive || undefined}
						onPointerMove={() => surface.onItemPointerMove(index)}
						onClick={() => surface.activate(index)}
					>
						<span className={styles.label}>{entry.label}</span>
						{entry.shortcut && (
							<span className={styles.shortcut} aria-hidden="true">
								{entry.shortcut}
							</span>
						)}
					</button>
				) : (
					<hr key={entry.id} className={styles.separator} />
				),
			)}
		</div>,
		document.body,
	);
};
