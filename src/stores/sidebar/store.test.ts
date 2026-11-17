import { afterEach, describe, expect, it, vi } from "vitest";

const fakeStorage = (initial: Record<string, string> = {}) => {
	const backing = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => backing.get(key) ?? null,
		setItem: (key: string, value: string) => {
			backing.set(key, value);
		},
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
	it("starts open", async () => {
		const { useSidebar } = await importStore(fakeStorage());
		expect(useSidebar.getState().visible).toBe(true);
	});

	it("toggles and remembers visibility", async () => {
		const storage = fakeStorage();
		const { toggleSidebar, useSidebar } = await importStore(storage);
		toggleSidebar();
		expect(useSidebar.getState().visible).toBe(false);
		const reloaded = await importStore(storage);
		expect(reloaded.useSidebar.getState().visible).toBe(false);
	});
});

describe("useSidebarWidth", () => {
	it("keeps the width between 150 and 280, a third of the window at most", async () => {
		const { useSidebarWidth } = await importStore(fakeStorage());
		const { limits } = useSidebarWidth;
		expect(useSidebarWidth.getState().width).toBe(220);
		expect([limits.min, limits.max, limits.maxShare]).toEqual([
			150,
			280,
			1 / 3,
		]);
	});
});
