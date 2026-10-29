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
	it("rejects unsupported desktop updates without invoking IPC", async () => {
		const platform = createWebPlatform();
		await expect(platform.updates.state()).rejects.toThrow("unavailable");
		await expect(platform.updates.check()).rejects.toThrow("unavailable");
		await expect(platform.updates.updateNow()).rejects.toThrow("unavailable");
	});
});
