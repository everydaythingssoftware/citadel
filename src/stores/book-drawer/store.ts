import { createPanelWidthStore } from "@/stores/panel-width";

/** How wide the book details drawer is, over at most 70% of the content panel. */
export const useBookDrawerWidth = createPanelWidthStore({
	key: "book-drawer-prefs",
	min: 380,
	max: 720,
	initial: 500,
	maxShare: 0.7,
});
