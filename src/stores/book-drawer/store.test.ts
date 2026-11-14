import { afterEach, describe, expect, it, vi } from "vitest";

const PREFS_KEY = "book-drawer-prefs";

const fakeStorage = (initial: Record<string, string> = {}) => {
	const backing = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => backing.get(key) ?? null,
		setItem: (key: string, value: string) => {
			backing.set(key, value);
		},
		backing,
	};
};

const importStore = async (storage: ReturnType<typeof fakeStorage>) => {
	vi.resetModules();
	vi.stubGlobal("window", { localStorage: storage });
	return await import("./store");
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useBookDrawer", () => {
	it("starts at the initial width", async () => {
		const { useBookDrawer, BOOK_DRAWER_WIDTH } = await importStore(
			fakeStorage(),
		);
		expect(useBookDrawer.getState().width).toBe(BOOK_DRAWER_WIDTH.initial);
	});

	it("clamps, persists and restores the width", async () => {
		const storage = fakeStorage();
		const { useBookDrawer } = await importStore(storage);
		useBookDrawer.getState().setWidth(9000);
		expect(useBookDrawer.getState().width).toBe(720);
		useBookDrawer.getState().setWidth(100);
		expect(useBookDrawer.getState().width).toBe(380);
		useBookDrawer.getState().setWidth(612.4);
		expect(JSON.parse(storage.backing.get(PREFS_KEY) ?? "{}")).toEqual({
			width: 612,
		});
		const reloaded = await importStore(storage);
		expect(reloaded.useBookDrawer.getState().width).toBe(612);
	});

	it("resets to the initial width", async () => {
		const { useBookDrawer, BOOK_DRAWER_WIDTH } = await importStore(
			fakeStorage({ [PREFS_KEY]: JSON.stringify({ width: 650 }) }),
		);
		expect(useBookDrawer.getState().width).toBe(650);
		useBookDrawer.getState().resetWidth();
		expect(useBookDrawer.getState().width).toBe(BOOK_DRAWER_WIDTH.initial);
	});

	it("ignores a corrupt stored value", async () => {
		const { useBookDrawer, BOOK_DRAWER_WIDTH } = await importStore(
			fakeStorage({ [PREFS_KEY]: "{not json" }),
		);
		expect(useBookDrawer.getState().width).toBe(BOOK_DRAWER_WIDTH.initial);
	});
});

describe("bookDrawerMaxWidth", () => {
	it("allows at most 70% of the panel, between the limits", async () => {
		const { bookDrawerMaxWidth } = await importStore(fakeStorage());
		expect(bookDrawerMaxWidth(null)).toBe(720);
		expect(bookDrawerMaxWidth(2000)).toBe(720);
		expect(bookDrawerMaxWidth(800)).toBe(560);
		expect(bookDrawerMaxWidth(400)).toBe(380);
	});
});
