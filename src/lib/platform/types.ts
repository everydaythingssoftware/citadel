import type {
	DatabaseBackup,
	DatabaseProblem,
	MenuCommand,
	MenuStateUpdate,
	RecoveryStep,
	UpdateNowOutcome,
} from "@/bindings";
import type { Option } from "@/lib/option";
import type { SoftwareUpdateState } from "@/lib/updates/software-update";
import type { OperatingSystem } from "./os";
import type { SettingsManager } from "./settings/types";

export interface PlatformAdapter {
	readonly os: OperatingSystem;
	readonly capabilities: PlatformCapabilities;
	readonly dialogs: DialogAdapter;
	readonly clipboard: ClipboardAdapter;
	readonly fileOpener: FileOpenerAdapter;
	readonly window: WindowAdapter;
	readonly homeDirectory: () => Promise<string | null>;
	readonly menu: Option<MenuAdapter>;
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
	/**
	 * The window has no native title bar: content extends under the window
	 * controls, so the app provides its own drag region and clears the controls.
	 */
	hasOverlayTitleBar: boolean;
}

export type { MenuCommand, MenuStateUpdate } from "@/bindings";

/** The desktop menu bar (macOS). */
export interface MenuAdapter {
	onCommand(handler: (command: MenuCommand) => void): Promise<() => void>;
	setState(update: MenuStateUpdate): Promise<void>;
}

/** A file on this computer, by path: what the desktop chooses and drops. */
export interface LocalFile {
	path: string;
	name: string;
}

/** Files dragged over the window from outside it. */
export type FileDragEvent =
	| { type: "enter" }
	| { type: "leave" }
	| { type: "drop"; files: LocalFile[] };

export interface DialogAdapter {
	openFile(options: {
		filters?: { name: string; extensions: string[] }[];
	}): Promise<string | null>;
	openDirectory(options?: { title?: string }): Promise<string | null>;
	/**
	 * Lets the person choose books to add: files read in the page itself in
	 * a browser (uploads), files by path on the desktop. Resolves with none
	 * when they cancel.
	 */
	chooseFiles(options: {
		extensions: string[];
		multiple?: boolean;
	}): Promise<File[] | LocalFile[]>;
}

export interface ClipboardAdapter {
	writeText(text: string): Promise<void>;
}

export interface FileOpenerAdapter {
	/** "Finder", "File Explorer" or "File Manager", for "Show in …" labels. */
	readonly fileManagerName: string;
	openPath(path: string): Promise<void>;
	revealInFileManager(path: string): Promise<void>;
	/**
	 * The app that opens this file by default, with its icon, cached per
	 * file extension. None in a browser, off macOS, or when none claims it.
	 */
	defaultApp(path: string): Promise<Option<DefaultApp>>;
	/** The macOS desktop app only; opens the default app if Quick Look fails. */
	readonly quickLook: Option<(path: string) => Promise<void>>;
}

export interface DefaultApp {
	name: string;
	/** A PNG data URL. */
	iconDataUrl: string;
}

export interface WindowAdapter {
	/** The library window, as opposed to the separate Settings window. */
	readonly isMain: boolean;
	show(): Promise<void>;
	hide(): Promise<void>;
	readonly toggleFullscreen: Option<() => Promise<void>>;
	openSettings(): Promise<void>;
	setTheme(theme: "dark" | "light" | null): Promise<void>;
	setBackgroundColor(color: [number, number, number, number]): Promise<void>;
	hideOnClose(): Promise<() => void>;
	/**
	 * Files dragged over the window, where the platform reports them by
	 * path (the desktop). Browsers deliver drops to the page instead.
	 */
	onFileDrag(handler: (event: FileDragEvent) => void): Promise<() => void>;
	/**
	 * Drags files out of the window to other apps, from a pointer-down or
	 * dragstart; the desktop only. Without an icon, the file manager's icon
	 * for the first file is shown.
	 */
	readonly startDrag: Option<
		(files: string[], iconPath?: string) => Promise<void>
	>;
	/**
	 * Whether the window is in front; the handler is called at once with the
	 * current value, then on every change.
	 */
	onActiveChange(handler: (active: boolean) => void): Promise<() => void>;
	/** Full screen entered or left; called at once with the current value. */
	onFullscreenChange(
		handler: (fullscreen: boolean) => void,
	): Promise<() => void>;
}

/**
 * Whether a newer Citadel is out: the app itself on the desktop, whose
 * backend owns the state (CDL-51); the server in the browser (CDL-73). The
 * state lists which of the actions below this platform performs.
 */
export interface UpdatesAdapter {
	/** Null when there is nothing to show, such as signed out in a browser. */
	state(): Promise<SoftwareUpdateState | null>;
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
