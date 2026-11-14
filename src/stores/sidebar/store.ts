import { create } from "zustand";

const PREFS_KEY = "sidebar-prefs";

export const SIDEBAR_WIDTH = {
	min: 180,
	max: 360,
	initial: 220,
	/** Arrow keys on the resize handle move it this far. */
	step: 10,
} as const;

export const clampSidebarWidth = (width: number): number =>
	Number.isFinite(width)
		? Math.round(
				Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)),
			)
		: SIDEBAR_WIDTH.initial;

interface SidebarPrefs {
	visible: boolean;
	width: number;
	/** "Hide Until Next Update" was chosen for this version. */
	hiddenUpdateVersion: string | null;
}

export interface SidebarState extends SidebarPrefs {
	toggleSidebar: () => void;
	setSidebarVisible: (visible: boolean) => void;
	setWidth: (width: number) => void;
	resetWidth: () => void;
	hideUpdateUntilNext: (version: string) => void;
}

const DEFAULTS: SidebarPrefs = {
	visible: true,
	width: SIDEBAR_WIDTH.initial,
	hiddenUpdateVersion: null,
};

const loadInitial = (): SidebarPrefs => {
	try {
		const stored = window.localStorage.getItem(PREFS_KEY);
		if (!stored) return DEFAULTS;
		const parsed = JSON.parse(stored) as Partial<SidebarPrefs>;
		return {
			visible:
				typeof parsed.visible === "boolean" ? parsed.visible : DEFAULTS.visible,
			width:
				typeof parsed.width === "number"
					? clampSidebarWidth(parsed.width)
					: DEFAULTS.width,
			hiddenUpdateVersion:
				typeof parsed.hiddenUpdateVersion === "string"
					? parsed.hiddenUpdateVersion
					: null,
		};
	} catch (_e) {
		return DEFAULTS;
	}
};

const persist = ({ visible, width, hiddenUpdateVersion }: SidebarPrefs) => {
	try {
		window.localStorage.setItem(
			PREFS_KEY,
			JSON.stringify({ visible, width, hiddenUpdateVersion }),
		);
	} catch (_e) {
		// Private windows can refuse storage; the sidebar still works this session.
	}
};

/**
 * The library window's sidebar: whether it shows, how wide it is, and which
 * update its footer row was told to keep quiet about. Per device, so it
 * lives beside the other view preferences in localStorage, not settings.json.
 */
export const useSidebar = create<SidebarState>((set, get) => ({
	...loadInitial(),

	toggleSidebar: () => {
		set({ visible: !get().visible });
		persist(get());
	},
	setSidebarVisible: (visible) => {
		set({ visible });
		persist(get());
	},
	setWidth: (width) => {
		const next = clampSidebarWidth(width);
		if (next === get().width) return;
		set({ width: next });
		persist(get());
	},
	resetWidth: () => {
		set({ width: SIDEBAR_WIDTH.initial });
		persist(get());
	},
	hideUpdateUntilNext: (version) => {
		set({ hiddenUpdateVersion: version });
		persist(get());
	},
}));

export const toggleSidebar = (): void => useSidebar.getState().toggleSidebar();
