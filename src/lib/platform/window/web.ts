import type { WindowAdapter } from "../types";
import { distinct } from "./distinct";
export const createWebWindow = (): WindowAdapter => ({
	isMain: true,
	show: async () => {},
	hide: async () => {},
	openSettings: async () => {},
	setTheme: async () => {},
	setBackgroundColor: async () => {},
	hideOnClose: async () => () => {},
	onFileDrag: async () => () => {},
	startDrag: async () => {},
	onActiveChange: async (handler) => {
		const report = distinct(handler);
		const onFocus = () => report(true);
		const onBlur = () => report(false);
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		report(document.hasFocus());
		return () => {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		};
	},
	onFullscreenChange: async (handler) => {
		const report = distinct(handler);
		const onChange = () => report(document.fullscreenElement !== null);
		document.addEventListener("fullscreenchange", onChange);
		onChange();
		return () => document.removeEventListener("fullscreenchange", onChange);
	},
});
