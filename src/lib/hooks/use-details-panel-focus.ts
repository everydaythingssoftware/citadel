import { type RefObject, useLayoutEffect } from "react";

/**
 * Where focus goes as the details panel opens and closes, given the panel
 * (`content`, while mounted) and the grid it shows a book of.
 */
export const useDetailsPanelFocus = (
	open: boolean,
	content: HTMLElement | null,
	grid: RefObject<HTMLElement | null>,
) => {
	// Closed with focus inside, the grid takes the keyboard back at once,
	// not after the slide-out, so the next Escape clears the selection.
	useLayoutEffect(() => {
		if (!open && content?.contains(document.activeElement))
			grid.current?.focus();
	}, [open, content, grid]);

	return {
		// Opened from the grid, the grid keeps focus so arrows move on
		// through the books; from a menu, land on the primary action.
		onOpenAutoFocus: (event: Event) => {
			event.preventDefault();
			if (grid.current?.contains(document.activeElement)) return;
			content
				?.querySelector<HTMLElement>("[data-drawer-initial-focus]")
				?.focus();
		},
		// No Dialog.Trigger to return focus to: hand it to the grid, unless
		// the user has already moved on (into the search field).
		onCloseAutoFocus: (event: Event) => {
			event.preventDefault();
			const focused = document.activeElement;
			if (
				focused === null ||
				focused === document.body ||
				content?.contains(focused)
			)
				grid.current?.focus();
		},
	};
};
