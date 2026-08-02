import type { SettingsManager } from "./settings/types";

export interface PlatformAdapter {
	readonly capabilities: PlatformCapabilities;
	readonly dialogs: DialogAdapter;
	readonly clipboard: ClipboardAdapter;
	readonly fileOpener: FileOpenerAdapter;
	readonly window: WindowAdapter;
	readonly settings: SettingsManager;
}

export interface PlatformCapabilities {
	canPickLocalFiles: boolean;
	canRevealInFileManager: boolean;
	canCopyToClipboard: boolean;
	canOpenLocalPaths: boolean;
	supportsAutoUpdates: boolean;
	supportsLocalOpdsServer: boolean;
}

export interface DialogAdapter {
	openFile(options: {
		filters?: { name: string; extensions: string[] }[];
	}): Promise<string | null>;
	openDirectory(options?: { title?: string }): Promise<string | null>;
}

export interface ClipboardAdapter {
	writeText(text: string): Promise<void>;
}

export interface FileOpenerAdapter {
	openPath(path: string): Promise<void>;
	revealInFileManager(path: string): Promise<void>;
}

export interface WindowAdapter {
	showMainWindow(): Promise<void>;
}
