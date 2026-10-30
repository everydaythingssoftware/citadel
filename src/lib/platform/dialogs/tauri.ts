import { open } from "@tauri-apps/plugin-dialog";
import type { DialogAdapter } from "../types";

export const createTauriDialogs = (): DialogAdapter => ({
	openFile: async (options) => {
		const result = await open({
			multiple: false,
			directory: false,
			filters: options.filters,
		});
		if (!result || Array.isArray(result)) return null;
		return result;
	},
	openDirectory: async (options) => {
		const result = await open({
			multiple: false,
			directory: true,
			recursive: true,
			title: options?.title,
		});
		if (typeof result === "string") return result;
		return null;
	},
	// The desktop app imports by path through openFile instead.
	chooseFiles: async () => [],
});
