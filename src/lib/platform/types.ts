import type {
	DatabaseBackup,
	DatabaseProblem,
	RecoveryStep,
	SoftwareUpdateState,
	UpdateNowOutcome,
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

/** Citadel's own updates; the desktop backend owns the state (CDL-51). */
export interface UpdatesAdapter {
	state(): Promise<SoftwareUpdateState>;
	/** Every state change, in every window. */
	onChange(handler: (state: SoftwareUpdateState) => void): Promise<() => void>;
	/** Settings is asked to show Software Update. */
	onShowRequested(handler: () => void): Promise<() => void>;
	check(): Promise<void>;
	/** Downloads now and installs at quit, where the install type allows. */
	later(): Promise<void>;
	/** Installs and relaunches; checks first if nothing was checked yet. */
	updateNow(): Promise<UpdateNowOutcome>;
	/** Opens Settings on General → Software Update. */
	showInSettings(): Promise<void>;
}

/** citadel.db that startup couldn't open (ADR 0009). */
export interface RecoveryAdapter {
	problem(): Promise<DatabaseProblem | null>;
	/** The backup a damaged database was replaced with at startup. */
	restored(): Promise<DatabaseBackup | null>;
	/** Restarts the app on success; `quit` exits it. */
	recover(step: RecoveryStep): Promise<void>;
}
