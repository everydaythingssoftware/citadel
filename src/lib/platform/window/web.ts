import type { WindowAdapter } from "../types";
export const createWebWindow = (): WindowAdapter => ({
	isMain: true,
	show: async () => {},
	hide: async () => {},
	openSettings: async () => {},
	setTheme: async () => {},
	setBackgroundColor: async () => {},
	hideOnClose: async () => () => {},
	onFileDrag: async () => () => {},
});
