/**
 * What the window-drag strip must let clicks through to: anything a click
 * means something on. Mirrors the controls Tauri's own drag script skips
 * (tauri `window/scripts/drag.js`), plus menus, popovers and toasts.
 */
export const WINDOW_DRAG_PASS_THROUGH = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	"label",
	"summary",
	'[contenteditable]:not([contenteditable="false"])',
	'[tabindex]:not([tabindex="-1"])',
	'[role="button"]',
	'[role="link"]',
	'[role="menu"]',
	'[role="menuitem"]',
	'[role="menuitemradio"]',
	'[role="menuitemcheckbox"]',
	'[role="listbox"]',
	'[role="option"]',
	'[role="tab"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="slider"]',
	'[role="status"]',
	'[role="tooltip"]',
	"[data-ctd-popover]",
	'[data-tauri-drag-region="false"]',
].join(", ");

interface ClosestQueryable {
	closest(selectors: string): unknown;
}

/** Whether the element under the strip should get the click instead. */
export const passesWindowDragThrough = (
	element: ClosestQueryable | null | undefined,
): boolean => Boolean(element?.closest(WINDOW_DRAG_PASS_THROUGH));
