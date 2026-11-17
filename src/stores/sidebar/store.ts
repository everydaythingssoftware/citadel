import { create } from "zustand";
import { createPanelWidthStore } from "@/stores/panel-width";

const VISIBLE_KEY = "sidebar-visible";

const loadVisible = (): boolean => {
	try {
		return window.localStorage.getItem(VISIBLE_KEY) !== "false";
	} catch (_e) {
		return true;
	}
};

interface SidebarState {
	visible: boolean;
	toggleSidebar: () => void;
}

/** Whether the library window's sidebar shows. Per device, in localStorage. */
export const useSidebar = create<SidebarState>((set, get) => ({
	visible: loadVisible(),
	toggleSidebar: () => {
		const visible = !get().visible;
		set({ visible });
		try {
			window.localStorage.setItem(VISIBLE_KEY, String(visible));
		} catch (_e) {
			// Private windows can refuse storage; the sidebar still works this session.
		}
	},
}));

export const toggleSidebar = (): void => useSidebar.getState().toggleSidebar();

export const useSidebarWidth = createPanelWidthStore({
	key: "sidebar-prefs",
	min: 150,
	max: 280,
	initial: 220,
	maxShare: 1 / 3,
});
