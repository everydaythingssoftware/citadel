import { create, type StoreApi, type UseBoundStore } from "zustand";

export interface PanelWidthLimits {
	/** localStorage key; the width is per device, not in settings.json. */
	key: string;
	min: number;
	max: number;
	initial: number;
	/** The most of its container the panel may take. */
	maxShare: number;
}

export interface PanelWidthState {
	width: number;
	/** Moves the edge; `saveWidth` remembers it, once the drag ends. */
	setWidth: (width: number) => void;
	saveWidth: () => void;
	resetWidth: () => void;
}

export type PanelWidthStore = UseBoundStore<StoreApi<PanelWidthState>> & {
	limits: PanelWidthLimits;
};

export const clampWidth = (
	{ min, max, initial }: PanelWidthLimits,
	width: number,
): number =>
	Number.isFinite(width)
		? Math.round(Math.min(max, Math.max(min, width)))
		: initial;

/**
 * The widest the panel may be in a container this wide: its share of it,
 * never under the minimum (a narrow window gets the minimum, not a sliver).
 */
export const maxWidthWithin = (
	{ min, max, maxShare }: PanelWidthLimits,
	containerWidth: number,
): number =>
	Math.max(min, Math.min(max, Math.floor(containerWidth * maxShare)));

const loadWidth = (limits: PanelWidthLimits): number => {
	try {
		const stored = window.localStorage.getItem(limits.key);
		const parsed: unknown = stored ? JSON.parse(stored) : null;
		return typeof parsed === "object" &&
			parsed !== null &&
			"width" in parsed &&
			typeof parsed.width === "number"
			? clampWidth(limits, parsed.width)
			: limits.initial;
	} catch (_e) {
		return limits.initial;
	}
};

const saveWidth = (key: string, width: number) => {
	try {
		window.localStorage.setItem(key, JSON.stringify({ width }));
	} catch (_e) {
		// Private windows can refuse storage; the width still holds this session.
	}
};

/** A resizable panel's width: clamped to `limits`, remembered per device. */
export const createPanelWidthStore = (
	limits: PanelWidthLimits,
): PanelWidthStore =>
	Object.assign(
		create<PanelWidthState>((set, get) => ({
			width: loadWidth(limits),
			setWidth: (width) => set({ width: clampWidth(limits, width) }),
			saveWidth: () => saveWidth(limits.key, get().width),
			resetWidth: () => {
				set({ width: limits.initial });
				saveWidth(limits.key, limits.initial);
			},
		})),
		{ limits },
	);
