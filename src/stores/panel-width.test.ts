import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clampWidth,
	createPanelWidthStore,
	maxWidthWithin,
	type PanelWidthLimits,
} from "./panel-width";

const LIMITS: PanelWidthLimits = {
	key: "panel",
	min: 150,
	max: 280,
	initial: 220,
	maxShare: 1 / 3,
};

const fakeStorage = (initial: Record<string, string> = {}) => {
	const backing = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => backing.get(key) ?? null,
		setItem: (key: string, value: string) => {
			backing.set(key, value);
		},
	};
};

const storeOn = (storage: ReturnType<typeof fakeStorage>) => {
	vi.stubGlobal("window", { localStorage: storage });
	return createPanelWidthStore(LIMITS);
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createPanelWidthStore", () => {
	it("starts at the initial width", () => {
		expect(storeOn(fakeStorage()).getState().width).toBe(220);
	});

	it("clamps as the edge moves, and remembers the width once saved", () => {
		const storage = fakeStorage();
		const store = storeOn(storage);
		store.getState().setWidth(9999);
		expect(store.getState().width).toBe(280);
		store.getState().setWidth(10);
		expect(store.getState().width).toBe(150);
		store.getState().setWidth(251.6);
		expect(storeOn(storage).getState().width).toBe(220);
		store.getState().saveWidth();
		expect(storeOn(storage).getState().width).toBe(252);
	});

	it("resets to the initial width, and remembers that", () => {
		const storage = fakeStorage({ panel: JSON.stringify({ width: 250 }) });
		const store = storeOn(storage);
		expect(store.getState().width).toBe(250);
		store.getState().resetWidth();
		expect(store.getState().width).toBe(220);
		expect(storeOn(storage).getState().width).toBe(220);
	});

	it("clamps a width stored under older, wider limits", () => {
		expect(
			storeOn(fakeStorage({ panel: JSON.stringify({ width: 360 }) })).getState()
				.width,
		).toBe(280);
	});

	it("ignores stored values of the wrong shape, or unreadable storage", () => {
		expect(
			storeOn(
				fakeStorage({ panel: JSON.stringify({ width: "wide" }) }),
			).getState().width,
		).toBe(220);
		expect(storeOn(fakeStorage({ panel: "{not json" })).getState().width).toBe(
			220,
		);
	});
});

describe("clampWidth", () => {
	it("falls back to the initial width for a non-number", () => {
		expect(clampWidth(LIMITS, Number.NaN)).toBe(220);
	});
});

describe("maxWidthWithin", () => {
	it("allows the panel's share of its container, between the limits", () => {
		expect(maxWidthWithin(LIMITS, 1440)).toBe(280);
		expect(maxWidthWithin(LIMITS, 720)).toBe(240);
		expect(maxWidthWithin(LIMITS, 640)).toBe(213);
		expect(maxWidthWithin(LIMITS, 300)).toBe(150);
	});
});
