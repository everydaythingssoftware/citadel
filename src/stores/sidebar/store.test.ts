import { afterEach, describe, expect, it, vi } from "vitest";

const PREFS_KEY = "sidebar-prefs";

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

describe("useSidebar", () => {
	it("starts open at the initial width", async () => {
		const { useSidebar, SIDEBAR_WIDTH } = await importStore(fakeStorage());
		expect(useSidebar.getState().visible).toBe(true);
		expect(useSidebar.getState().width).toBe(SIDEBAR_WIDTH.initial);
		expect(useSidebar.getState().hiddenUpdateVersion).toBeNull();
	});

	it("toggles and remembers visibility", async () => {
		const storage = fakeStorage();
		const { toggleSidebar, useSidebar } = await importStore(storage);
		toggleSidebar();
		expect(useSidebar.getState().visible).toBe(false);
		const reloaded = await importStore(storage);
		expect(reloaded.useSidebar.getState().visible).toBe(false);
	});

	it("clamps and remembers the width; reset returns to the initial width", async () => {
		const storage = fakeStorage();
		const { useSidebar, SIDEBAR_WIDTH } = await importStore(storage);
		useSidebar.getState().setWidth(9999);
		expect(useSidebar.getState().width).toBe(SIDEBAR_WIDTH.max);
		useSidebar.getState().setWidth(10);
		expect(useSidebar.getState().width).toBe(SIDEBAR_WIDTH.min);
		useSidebar.getState().setWidth(251.6);
		const reloaded = await importStore(storage);
		expect(reloaded.useSidebar.getState().width).toBe(252);
		reloaded.useSidebar.getState().resetWidth();
		expect(reloaded.useSidebar.getState().width).toBe(SIDEBAR_WIDTH.initial);
	});

	it("remembers the hidden update version", async () => {
		const storage = fakeStorage();
		const { useSidebar } = await importStore(storage);
		useSidebar.getState().hideUpdateUntilNext("1.4.0");
		const reloaded = await importStore(storage);
		expect(reloaded.useSidebar.getState().hiddenUpdateVersion).toBe("1.4.0");
	});

	it("ignores stored values of the wrong shape", async () => {
		const { useSidebar, SIDEBAR_WIDTH } = await importStore(
			fakeStorage({
				[PREFS_KEY]: JSON.stringify({
					visible: "yes",
					width: "wide",
					hiddenUpdateVersion: 3,
				}),
			}),
		);
		expect(useSidebar.getState()).toMatchObject({
			visible: true,
			width: SIDEBAR_WIDTH.initial,
			hiddenUpdateVersion: null,
		});
	});

	it("survives unreadable storage", async () => {
		const { useSidebar } = await importStore(
			fakeStorage({ [PREFS_KEY]: "{not json" }),
		);
		expect(useSidebar.getState().visible).toBe(true);
	});
});
