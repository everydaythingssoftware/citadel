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

/** True once per request: the caller focuses the search field. */
export const takeFindRequest = (): boolean => {
	if (!useMenuRequests.getState().findPending) return false;
	useMenuRequests.setState({ findPending: false });
	return true;
};

export const setShelfSheetOpen = (shelfSheetOpen: boolean) =>
	useMenuRequests.setState({ shelfSheetOpen });
