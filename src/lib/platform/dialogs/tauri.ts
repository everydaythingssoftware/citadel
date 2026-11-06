import { open } from "@tauri-apps/plugin-dialog";
import { localFile } from "../local-file";
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
	chooseFiles: async ({ extensions, multiple }) => {
		const result = await open({
			multiple: multiple ?? false,
			directory: false,
			filters: [{ name: "Books", extensions }],
		});
		const paths = result === null ? [] : [result].flat();
		return paths.map(localFile);
	},
});
