import { type EditableTargetLike, isEditableTarget } from "@/lib/keymap";

/** The part of Element read here, so it can be tested without a DOM. */
export interface KeyboardOwnerTarget extends EditableTargetLike {
	closest(selector: string): unknown;
}

/**
 * Sheets, alerts and menus own the keyboard while they are open. The book
 * drawer doesn't: it shows the selection, so the Book menu still applies.
 */
const OVERLAY_SELECTOR =
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

/**
 * Whether an open sheet or alert keeps app-wide chords (Go, Find, Add
 * Book…) from running. The details panel is a non-modal dialog the app
 * stays live beside, so it never does.
 */
export const overlayBlocksAppChords = (
	openDialogs: readonly { hasAttribute(name: string): boolean }[],
): boolean => openDialogs.some((dialog) => !dialog.hasAttribute("data-drawer"));

export const overlayOpen = (): boolean =>
	overlayBlocksAppChords([
		...document.querySelectorAll(
			'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
		),
	]);

/**
 * Layers that take an Escape before a panel or page behind them: an open
 * sheet, alert, popover, menu or select list.
 */
const ESCAPE_FIRST_SELECTOR =
	'[role="dialog"][data-state="open"]:not([data-drawer]), [role="alertdialog"], [role="menu"], [role="listbox"][data-state="open"]';

export const escapeLayerOpen = (): boolean =>
	document.querySelector(ESCAPE_FIRST_SELECTOR) !== null;
