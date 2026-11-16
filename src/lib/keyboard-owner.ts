import { type EditableTargetLike, isEditableTarget } from "@/lib/keymap";

/** The part of Element read here, so it can be tested without a DOM. */
export interface KeyboardOwnerTarget extends EditableTargetLike {
	closest(selector: string): unknown;
}

/**
 * Sheets, alerts and menus own the keyboard while they are open. The book
 * drawer doesn't: it shows the selection, so the Book menu still applies.
 */
export const OVERLAY_SELECTOR =
	'[role="alertdialog"], [role="dialog"]:not([data-drawer]), [role="menu"]';

/**
 * Whether the focused element takes typing or sits in an overlay, so app
 * shortcuts that act on books (⌘⌫, ⌘E…) must leave the keys to it.
 */
export const keyboardBusyAt = (
	focused: KeyboardOwnerTarget | null | undefined,
): boolean =>
	focused != null &&
	(isEditableTarget(focused) || focused.closest(OVERLAY_SELECTOR) != null);
