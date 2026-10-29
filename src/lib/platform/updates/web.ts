import type { UpdatesAdapter } from "../types";

const unavailable = async (): Promise<never> => {
	throw new Error("Desktop updates are unavailable in the browser");
};

export const webUpdates: UpdatesAdapter = {
	state: unavailable,
	onChange: async () => () => {},
	onShowRequested: async () => () => {},
	check: unavailable,
	later: unavailable,
	updateNow: unavailable,
	showInSettings: unavailable,
};
