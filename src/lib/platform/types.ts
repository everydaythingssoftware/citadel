import type {
	DatabaseBackup,
	DatabaseProblem,
	RecoveryStep,
	UpdateCheckResult,
} from "@/bindings";
import type { SettingsManager } from "./settings/types";

export interface PlatformAdapter {
	readonly capabilities: PlatformCapabilities;
	readonly dialogs: DialogAdapter;
	readonly clipboard: ClipboardAdapter;
	readonly fileOpener: FileOpenerAdapter;
	readonly window: WindowAdapter;
	readonly homeDirectory: () => Promise<string | null>;
	readonly menu: { onAddBook(handler: () => void): Promise<() => void> };
	readonly updates: UpdatesAdapter;
	readonly recovery: RecoveryAdapter;
	readonly settings: SettingsManager;
}

export interface PlatformCapabilities {
	supportsNativeWindows: boolean;
	canPickLocalFiles: boolean;
	canRevealInFileManager: boolean;
	canCopyToClipboard: boolean;
	canOpenLocalPaths: boolean;
	supportsAutoUpdates: boolean;
	/** Only the desktop build can host the local OPDS server. */
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
	show(): Promise<void>;
	hide(): Promise<void>;
	openSettings(): Promise<void>;
	setTheme(theme: "dark" | "light" | null): Promise<void>;
	setBackgroundColor(color: [number, number, number, number]): Promise<void>;
	hideOnClose(): Promise<() => void>;
}

export interface UpdatesAdapter {
	check(): Promise<UpdateCheckResult>;
	install(): Promise<"no-update">;
}

/** citadel.db that startup couldn't open (ADR 0009). */
export interface RecoveryAdapter {
	problem(): Promise<DatabaseProblem | null>;
	/** The backup a damaged database was replaced with at startup. */
	restored(): Promise<DatabaseBackup | null>;
	/** Restarts the app on success; `quit` exits it. */
	recover(step: RecoveryStep): Promise<void>;
}
