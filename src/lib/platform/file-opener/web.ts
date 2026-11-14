import { detectOperatingSystem } from "../os";
import type { FileOpenerAdapter } from "../types";
import { fileManagerNameFor } from "./file-manager-name";

export const createWebFileOpener = (): FileOpenerAdapter => ({
	fileManagerName: fileManagerNameFor(detectOperatingSystem()),
	openPath: (path) => {
		window.open(path, "_blank", "noopener,noreferrer");
		return Promise.resolve();
	},
	revealInFileManager: () => Promise.resolve(),
	defaultApp: async () => null,
	quickLook: async () => {},
});
