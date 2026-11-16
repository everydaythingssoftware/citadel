export { PlatformProvider, usePlatform } from "./context";
export { createTauriPlatform, createWebPlatform } from "./create";
export { detectOperatingSystem, type OperatingSystem } from "./os";
export type {
	LibraryPath,
	SettingsKey,
	SettingsManager,
	SettingsSchema,
	SettingsValue,
} from "./settings/types";
export type {
	ClipboardAdapter,
	DialogAdapter,
	FileDragEvent,
	FileOpenerAdapter,
	LocalFile,
	PlatformAdapter,
	PlatformCapabilities,
	WindowAdapter,
} from "./types";
