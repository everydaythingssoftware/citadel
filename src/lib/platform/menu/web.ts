import type { MenuAdapter } from "../types";

/** Browsers have no menu bar: nothing to listen to, nothing to show. */
export const webMenu: MenuAdapter = {
	onAddBook: async () => () => {},
	onCommand: async () => () => {},
	setState: async () => {},
};
