import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { detectOperatingSystem } from "../os";
import type { FileOpenerAdapter } from "../types";
import { fileManagerNameFor } from "./file-manager-name";

export const createTauriFileOpener = (): FileOpenerAdapter => ({
	fileManagerName: fileManagerNameFor(detectOperatingSystem()),
	openPath: async (path) => {
		await openPath(path);
	},
	revealInFileManager: async (path) => {
		await revealItemInDir(path);
	},
});
