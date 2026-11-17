import type { WindowAdapter } from "../types";
import { none } from "@/lib/option";
export const createWebWindow = (): WindowAdapter => ({
	isMain: true,
	show: async () => {},
	hide: async () => {},
	openSettings: async () => {},
	setTheme: async () => {},
	setBackgroundColor: async () => {},
	hideOnClose: async () => () => {},
	onFileDrag: async () => () => {},
	startDrag: none(),
	onActiveChange: async (handler) => {
		const onFocus = () => handler(true);
		const onBlur = () => handler(false);
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		handler(document.hasFocus());
		return () => {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		};
	},
	onFullscreenChange: async (handler) => {
		const onChange = () => handler(document.fullscreenElement !== null);
		document.addEventListener("fullscreenchange", onChange);
		onChange();
		return () => document.removeEventListener("fullscreenchange", onChange);
	},
});
