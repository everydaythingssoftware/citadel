import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "@/bindings";
import { localFile } from "../local-file";
import type { WindowAdapter } from "../types";

export const createTauriWindow = (): WindowAdapter => ({
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
});
