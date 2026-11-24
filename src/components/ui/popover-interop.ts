/**
 * Kit popovers (e.g. the TagsInput completion list) render in body portals so
 * they can escape scrolling dialog content. Radix's modal dialogs see them as
 * "outside" and would close on click, and the modal pointer-events lock would
 * make them inert. Popover roots carry this attribute; dialogs use the guard
 * to ignore interactions inside them, and the CSS module sets
 * pointer-events: auto on the popover itself.
 */
export const POPOVER_ATTRIBUTE = "data-ctd-popover";

export const ignorePopoverInteractOutside = (
	event: CustomEvent<{ originalEvent: Event }> | Event,
) => {
	const target =
		"detail" in event &&
		(event as CustomEvent<{ originalEvent: Event }>).detail?.originalEvent
			? ((event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent
					.target as Element | null)
			: (event.target as Element | null);
	if (target?.closest(`[${POPOVER_ATTRIBUTE}]`)) {
		event.preventDefault();
	}
};

/**
 * Whether the target is a combobox that shows its list, for example the input
 * of a TagsInput with its completions. An Escape there closes only the list,
 * thus a dialog must stay open.
 */
export const isOpenCombobox = (
	target: Pick<Element, "getAttribute"> | null,
): boolean =>
	target?.getAttribute("role") === "combobox" &&
	target.getAttribute("aria-expanded") === "true";

/** An Escape in an open completion list closes only the list. */
export const keepOpenForList = (event: KeyboardEvent) => {
	if (isOpenCombobox(event.target as Element | null)) event.preventDefault();
};
