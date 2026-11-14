import { create } from "zustand";

const PREFS_KEY = "book-drawer-prefs";

export const BOOK_DRAWER_WIDTH = {
	min: 380,
	max: 720,
	initial: 500,
	/** The most of the content panel the drawer may cover. */
	maxShare: 0.7,
	/** Arrow keys on the resize handle move it this far. */
	step: 10,
} as const;

export const clampBookDrawerWidth = (width: number): number =>
	Number.isFinite(width)
		? Math.round(
				Math.min(BOOK_DRAWER_WIDTH.max, Math.max(BOOK_DRAWER_WIDTH.min, width)),
			)
		: BOOK_DRAWER_WIDTH.initial;

/**
 * The widest the drawer may be over a content panel this wide: 70% of it,
 * never under the minimum (a narrow window gets the minimum, not a sliver).
 */
export const bookDrawerMaxWidth = (panelWidth: number | null): number =>
	panelWidth === null || !Number.isFinite(panelWidth)
		? BOOK_DRAWER_WIDTH.max
		: Math.max(
				BOOK_DRAWER_WIDTH.min,
				Math.min(
					BOOK_DRAWER_WIDTH.max,
					Math.floor(panelWidth * BOOK_DRAWER_WIDTH.maxShare),
				),
			);

interface BookDrawerState {
	width: number;
	setWidth: (width: number) => void;
	resetWidth: () => void;
}

const loadWidth = (): number => {
	try {
		const stored = window.localStorage.getItem(PREFS_KEY);
		if (!stored) return BOOK_DRAWER_WIDTH.initial;
		const parsed = JSON.parse(stored) as { width?: unknown };
		return typeof parsed.width === "number"
			? clampBookDrawerWidth(parsed.width)
			: BOOK_DRAWER_WIDTH.initial;
	} catch (_e) {
		return BOOK_DRAWER_WIDTH.initial;
	}
};

const persist = (width: number) => {
	try {
		window.localStorage.setItem(PREFS_KEY, JSON.stringify({ width }));
	} catch (_e) {
		// Private windows can refuse storage; the width still holds this session.
	}
};

/**
 * How wide the book details drawer is. Per device, like the sidebar's
 * width, so it lives in localStorage rather than settings.json.
 */
export const useBookDrawer = create<BookDrawerState>((set, get) => ({
	width: loadWidth(),
	setWidth: (width) => {
		const next = clampBookDrawerWidth(width);
		if (next === get().width) return;
		set({ width: next });
		persist(next);
	},
	resetWidth: () => {
		set({ width: BOOK_DRAWER_WIDTH.initial });
		persist(BOOK_DRAWER_WIDTH.initial);
	},
}));
