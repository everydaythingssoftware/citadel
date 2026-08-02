import { createTauriClipboard } from "./clipboard/tauri";
import { createWebClipboard } from "./clipboard/web";
import { createTauriDialogs } from "./dialogs/tauri";
import { createWebDialogs } from "./dialogs/web";
import { createTauriFileOpener } from "./file-opener/tauri";
import { createWebFileOpener } from "./file-opener/web";
import { createTauriSettingsManager } from "./settings/tauri";
import { defaultSettings } from "./settings/types";
import { createWebSettingsManager } from "./settings/web";
import type { PlatformAdapter } from "./types";
import { createTauriWindow } from "./window/tauri";
import { createWebWindow } from "./window/web";

export const createTauriPlatform = (): PlatformAdapter => ({
	capabilities: {
		canPickLocalFiles: true,
		canRevealInFileManager: true,
		canCopyToClipboard: true,
		canOpenLocalPaths: true,
		supportsAutoUpdates: true,
		supportsLocalOpdsServer: true,
	},
	dialogs: createTauriDialogs(),
	clipboard: createTauriClipboard(),
	fileOpener: createTauriFileOpener(),
	window: createTauriWindow(),
	settings: createTauriSettingsManager(defaultSettings),
});

export const createWebPlatform = (): PlatformAdapter => ({
	capabilities: {
		canPickLocalFiles: false,
		canRevealInFileManager: false,
		canCopyToClipboard: true,
		canOpenLocalPaths: false,
		supportsAutoUpdates: false,
		supportsLocalOpdsServer: false,
	},
	dialogs: createWebDialogs(),
	clipboard: createWebClipboard(),
	fileOpener: createWebFileOpener(),
	window: createWebWindow(),
	settings: createWebSettingsManager(defaultSettings),
});
