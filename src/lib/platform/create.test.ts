import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bindings", () => ({
	commands: new Proxy(
		{},
		{
			get: () => {
				throw new Error("Native command invoked from browser");
			},
		},
	),
}));

import { createPlatform, createWebPlatform } from "./create";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("browser Platform", () => {
	it("selects web capabilities and handles window/menu lifecycle without native calls", async () => {
		const platform = createPlatform();
		expect(platform.capabilities.supportsNativeWindows).toBe(false);
		expect(platform.capabilities.supportsAutoUpdates).toBe(false);
		expect(await platform.homeDirectory()).toBeNull();
		await platform.window.show();
		await platform.window.hide();
		await platform.window.setTheme(null);
		await platform.window.setBackgroundColor([0, 0, 0, 255]);
		const close = await platform.window.hideOnClose();
		close();
	});
	it("has no menu bar, Quick Look, default apps or file drags", async () => {
		const platform = createWebPlatform();
		expect(platform.menu.isSome).toBe(false);
		expect(platform.fileOpener.quickLook.isSome).toBe(false);
		expect(platform.window.startDrag.isSome).toBe(false);
		expect((await platform.fileOpener.defaultApp("/a/book.epub")).isSome).toBe(
			false,
		);
	});
	it("follows the page's focus and full screen", async () => {
		const page = Object.assign(new EventTarget(), {
			hasFocus: () => false,
			fullscreenElement: null as object | null,
		});
		vi.stubGlobal("window", new EventTarget());
		vi.stubGlobal("document", page);
		const platform = createWebPlatform();
		const active: boolean[] = [];
		const fullscreen: boolean[] = [];
		const stopActive = await platform.window.onActiveChange((value) =>
			active.push(value),
		);
		const stopFullscreen = await platform.window.onFullscreenChange((value) =>
			fullscreen.push(value),
		);
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("focus"));
		page.fullscreenElement = {};
		page.dispatchEvent(new Event("fullscreenchange"));
		stopActive();
		stopFullscreen();
		window.dispatchEvent(new Event("blur"));
		expect(active).toEqual([false, true, true]);
		expect(fullscreen).toEqual([false, true]);
	});
	it("offers no way to install updates from the browser", async () => {
		const platform = createWebPlatform();
		await expect(platform.updates.check()).rejects.toThrow(
			"not from the browser",
		);
		await expect(platform.updates.later()).rejects.toThrow(
			"not from the browser",
		);
		await expect(platform.updates.updateNow()).rejects.toThrow(
			"not from the browser",
		);
	});
});
