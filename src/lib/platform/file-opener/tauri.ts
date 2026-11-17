import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands } from "@/bindings";
import { none, some } from "@/lib/option";
import { detectOperatingSystem } from "../os";
import type { FileOpenerAdapter } from "../types";
import { cacheByExtension } from "./default-app-cache";
import { fileManagerNameFor } from "./file-manager-name";

const quickLook = async (path: string) => {
	const result = await commands.clbCmdQuickLook(path);
	if (result.status === "error") throw new Error(result.error);
};

export const createTauriFileOpener = (): FileOpenerAdapter => {
	const os = detectOperatingSystem();
	return {
		fileManagerName: fileManagerNameFor(os),
		openPath: async (path) => {
			await openPath(path);
		},
		revealInFileManager: async (path) => {
			await revealItemInDir(path);
		},
		defaultApp: cacheByExtension(async (path) => {
			const app = await commands.clbQueryDefaultApp(path);
			return app === null ? none() : some(app);
		}),
		quickLook: os === "macos" ? some(quickLook) : none(),
	};
};
