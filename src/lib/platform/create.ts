import { isDesktop } from "./runtime";
import { homeDirectory } from "./paths/tauri";
import { onAddBook } from "./menu/tauri";
import { tauriUpdates } from "./updates/tauri";
import { webUpdates } from "./updates/web";
import { tauriRecovery } from "./recovery/tauri";
import { webRecovery } from "./recovery/web";
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
		supportsNativeWindows: true,
		canPickLocalFiles: true,
		canRevealInFileManager: true,
		canCopyToClipboard: true,
		canOpenLocalPaths: true,
		supportsAutoUpdates: true,
		supportsLocalOpdsServer: true,
	},
	homeDirectory,
	menu: { onAddBook },
	updates: tauriUpdates,
	recovery: tauriRecovery,
	dialogs: createTauriDialogs(),
	clipboard: createTauriClipboard(),
	fileOpener: createTauriFileOpener(),
	window: createTauriWindow(),
	settings: createTauriSettingsManager(defaultSettings),
});

export const createWebPlatform = (): PlatformAdapter => ({
	capabilities: {
		supportsNativeWindows: false,
		canPickLocalFiles: false,
		canRevealInFileManager: false,
		canCopyToClipboard: true,
		canOpenLocalPaths: false,
		supportsAutoUpdates: false,
		supportsLocalOpdsServer: false,
	},
	homeDirectory: async () => null,
	menu: { onAddBook: async () => () => {} },
	updates: webUpdates,
	recovery: webRecovery,
	dialogs: createWebDialogs(),
	clipboard: createWebClipboard(),
	fileOpener: createWebFileOpener(),
	window: createWebWindow(),
	settings: createWebSettingsManager(defaultSettings),
});

export const createPlatform = (): PlatformAdapter =>
	isDesktop ? createTauriPlatform() : createWebPlatform();
