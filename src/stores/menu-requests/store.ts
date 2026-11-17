import { create } from "zustand";

interface MenuRequestsState {
	/** Find was chosen; the Books page focuses its search once it shows. */
	findPending: boolean;
	/** New Shelf…: the Save as Shelf sheet is open. */
	shelfSheetOpen: boolean;
}

/**
 * Requests from the menu bar and the keyboard for flows that live in a
 * page or a dialog, which takes each one up when it is on screen.
 */
export const useMenuRequests = create<MenuRequestsState>(() => ({
	findPending: false,
	shelfSheetOpen: false,
}));

export const requestFind = () =>
	useMenuRequests.setState({ findPending: true });

export const setShelfSheetOpen = (shelfSheetOpen: boolean) =>
	useMenuRequests.setState({ shelfSheetOpen });
