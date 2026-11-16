import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands } from "@/bindings";
import { detectOperatingSystem } from "../os";
import type { FileOpenerAdapter } from "../types";
import { cacheByExtension } from "./default-app-cache";
import { fileManagerNameFor } from "./file-manager-name";
import { quickLookWithFallback } from "./quick-look-fallback";

const quickLook = quickLookWithFallback({
	quickLook: async (path) => {
		const result = await commands.clbCmdQuickLook(path);
		if (result.status === "error") throw new Error(result.error);
	},
	openPath: (path) => openPath(path),
});

/** False for the rest of the session once the Quick Look panel has failed. */
export const quickLookAvailable = quickLook.available;

export const createTauriFileOpener = (): FileOpenerAdapter => ({
	fileManagerName: fileManagerNameFor(detectOperatingSystem()),
	openPath: async (path) => {
		await openPath(path);
	},
	revealInFileManager: async (path) => {
		await revealItemInDir(path);
	},
	defaultApp: cacheByExtension((path) => commands.clbQueryDefaultApp(path)),
	quickLook: quickLook.quickLook,
});
