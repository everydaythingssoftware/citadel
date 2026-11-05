import { describe, expect, it, vi } from "vitest";
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
		const add = await platform.menu.onAddBook(() => {
			throw new Error("Unexpected native menu event");
		});
		add();
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
