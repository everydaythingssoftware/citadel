import { type EditableTargetLike, isEditableTarget } from "@/lib/keymap";

/** Layers that take an Escape before an inspector panel does. */
export const ESCAPE_FIRST_SELECTOR =
	'[role="dialog"][data-state="open"]:not([data-drawer-panel]), [role="alertdialog"], [role="menu"], [role="listbox"][data-state="open"]';

export interface EscapeTargetLike extends EditableTargetLike {
	value?: unknown;
}

const hasTextToClear = (target: EscapeTargetLike | null | undefined): boolean =>
	isEditableTarget(target) &&
	!target?.isContentEditable &&
	typeof target?.value === "string" &&
	target.value !== "";

/**
 * Whether an Escape closes an open inspector panel: on the first press
 * wherever focus is (the grid beside it, the panel, the page), unless a
 * menu, pop-up, sheet or alert is on top (`layerAbove`), or focus is in a
 * field with text for Escape to clear first.
 */
export const panelTakesEscape = (
	target: EscapeTargetLike | null | undefined,
	layerAbove: boolean,
): boolean => !layerAbove && !hasTextToClear(target);
