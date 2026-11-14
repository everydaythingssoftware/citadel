import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "@/bindings";
import { dragOutGuard } from "@/lib/drag-out-guard";
import { localFile } from "../local-file";
import type { WindowAdapter } from "../types";
import { distinct } from "./distinct";

// The drag plugin needs an image; this one shows nothing.
const BLANK_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const dragIconFor = async (path: string): Promise<string> =>
	(await commands.clbQueryFileIcon(path)) ?? BLANK_PNG;

export const createTauriWindow = (): WindowAdapter => ({
	isMain: getCurrentWindow().label === "main",
	show: async () => {
		const window = getCurrentWindow();
		await window.show();
		await window.setFocus();
	},
	hide: () => getCurrentWindow().hide(),
	openSettings: () => commands.clbCmdOpenSettings(),
	setTheme: (theme) => getCurrentWindow().setTheme(theme),
	setBackgroundColor: (color) => getCurrentWindow().setBackgroundColor(color),
	hideOnClose: () =>
		getCurrentWindow().onCloseRequested((event) => {
			event.preventDefault();
			void getCurrentWindow().hide();
		}),
	// The webview takes file drops natively and reports their paths.
	onFileDrag: (handler) =>
		getCurrentWebview().onDragDropEvent(({ payload }) => {
			switch (payload.type) {
				case "enter":
					handler({ type: "enter" });
					break;
				case "leave":
					handler({ type: "leave" });
					break;
				case "drop":
					handler({ type: "drop", files: payload.paths.map(localFile) });
					break;
			}
		}),
	startDrag: async (files, iconPath) => {
		const [first] = files;
		if (first === undefined) return;
		const icon = iconPath ?? (await dragIconFor(first));
		dragOutGuard.begin();
		try {
			await startDrag({ item: files, icon, mode: "copy" }, () =>
				dragOutGuard.end(),
			);
		} catch (error) {
			dragOutGuard.end();
			throw error;
		}
	},
	onActiveChange: async (handler) => {
		const window = getCurrentWindow();
		const report = distinct(handler);
		// The window starts hidden and is shown after first paint, so the
		// first answer to isFocused() is often "no". If a focus event has
		// arrived by the time that answer does, the event is newer: a late
		// "no" must not leave the window greyed out while it is in front.
		let heardEvent = false;
		const unlisten = await window.onFocusChanged(({ payload }) => {
			heardEvent = true;
			report(payload);
		});
		const focused = await window.isFocused();
		if (!heardEvent) report(focused);
		return unlisten;
	},
	// macOS reports the end of a full-screen transition as a resize.
	onFullscreenChange: async (handler) => {
		const window = getCurrentWindow();
		const report = distinct(handler);
		const unlisten = await window.onResized(async () =>
			report(await window.isFullscreen()),
		);
		report(await window.isFullscreen());
		return unlisten;
	},
});
