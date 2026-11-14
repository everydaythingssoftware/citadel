import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands } from "@/bindings";
import { detectOperatingSystem } from "../os";
import type { FileOpenerAdapter } from "../types";
import { cacheByExtension } from "./default-app-cache";
import { fileManagerNameFor } from "./file-manager-name";

export const createTauriFileOpener = (): FileOpenerAdapter => ({
	fileManagerName: fileManagerNameFor(detectOperatingSystem()),
	openPath: async (path) => {
		await openPath(path);
	},
	revealInFileManager: async (path) => {
		await revealItemInDir(path);
	},
	defaultApp: cacheByExtension((path) => commands.clbQueryDefaultApp(path)),
	quickLook: async (path) => {
		const result = await commands.clbCmdQuickLook(path);
		if (result.status === "error") throw new Error(result.error);
	},
});
