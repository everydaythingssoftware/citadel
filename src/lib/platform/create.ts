import { none, some } from "@/lib/option";
import { createTauriClipboard } from "./clipboard/tauri";
import { createWebClipboard } from "./clipboard/web";
import { createTauriDialogs } from "./dialogs/tauri";
import { createWebDialogs } from "./dialogs/web";
import { createTauriFileOpener } from "./file-opener/tauri";
import { createWebFileOpener } from "./file-opener/web";
import { tauriMenu } from "./menu/tauri";
import { detectOperatingSystem } from "./os";
import { homeDirectory } from "./paths/tauri";
import { tauriRecovery } from "./recovery/tauri";
import { webRecovery } from "./recovery/web";
import { isDesktop } from "./runtime";
import { createTauriSettingsManager } from "./settings/tauri";
import { defaultSettings } from "./settings/types";
import { createWebSettingsManager } from "./settings/web";
import type { PlatformAdapter } from "./types";
import { tauriUpdates } from "./updates/tauri";
import { webUpdates } from "./updates/web";
import { createTauriWindow } from "./window/tauri";
import { createWebWindow } from "./window/web";

export const createTauriPlatform = (): PlatformAdapter => {
	const os = detectOperatingSystem();
	return {
		os,
		capabilities: {
			supportsNativeWindows: true,
			canPickLocalFiles: true,
			canRevealInFileManager: true,
			canCopyToClipboard: true,
			canOpenLocalPaths: true,
			supportsAutoUpdates: true,
			supportsLocalOpdsServer: true,
			hasOverlayTitleBar: os === "macos",
		},
		homeDirectory,
		menu: os === "macos" ? some(tauriMenu) : none(),
		updates: tauriUpdates,
		recovery: tauriRecovery,
		dialogs: createTauriDialogs(),
		clipboard: createTauriClipboard(),
		fileOpener: createTauriFileOpener(),
		window: createTauriWindow(),
		settings: createTauriSettingsManager(defaultSettings),
	};
};

export const createWebPlatform = (): PlatformAdapter => ({
	os: detectOperatingSystem(),
	capabilities: {
		supportsNativeWindows: false,
		canPickLocalFiles: false,
		canRevealInFileManager: false,
		canCopyToClipboard: true,
		canOpenLocalPaths: false,
		supportsAutoUpdates: false,
		supportsLocalOpdsServer: false,
		hasOverlayTitleBar: false,
	},
	homeDirectory: async () => null,
	menu: none(),
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
