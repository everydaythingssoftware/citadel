import type {
	DatabaseBackup,
	DatabaseProblem,
	RecoveryStep,
	UpdateNowOutcome,
} from "@/bindings";
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
	readonly menu: MenuAdapter;
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
	/** Quick Look previews: the macOS desktop app only. */
	canQuickLook: boolean;
	/** Books' files can be dragged out of the window to other apps. */
	canDragFilesOut: boolean;
}

/**
 * A choice from the desktop menu bar (macOS), mirroring the Rust
 * `MenuCommand`. Select All is the native item and never arrives here on
 * macOS; Restart to Update is handled natively and never arrives either.
 */
export type MenuCommand =
	| "new-shelf"
	| "add-library"
	| "show-library-in-file-manager"
	| "find"
	| "undo"
	| "redo"
	| "select-all"
	| "book-show-details"
	| "book-open"
	| "book-edit"
	| "book-mark-finished"
	| "book-show-in-file-manager"
	| "book-copy-title"
	| "book-delete"
	| "toggle-sidebar"
	| "toggle-unread-only"
	| "sort-name-az"
	| "sort-name-za"
	| "sort-author-az"
	| "sort-author-za"
	| "go-all-books"
	| "go-authors"
	| "go-series"
	| "go-tags"
	| "go-publishers"
	| "go-back"
	| "go-forward"
	| "restart-to-update"
	| { switchLibrary: string };

/** What the menu bar shows that only the library window knows. */
export interface MenuState {
	/** Enables the Book menu; labels pluralise ("Delete 2 Books…"). */
	selectedBookCount: number;
	/** "Mark as Unfinished" instead of "Mark as Finished". */
	selectionAllFinished: boolean;
	/** "Hide Sidebar" or "Show Sidebar". */
	sidebarVisible: boolean;
	unreadOnly: boolean;
	sortOrder: "nameAz" | "nameZa" | "authorAz" | "authorZa";
	/** The Switch Library submenu, checkmark on the active one. */
	libraries: { id: string; name: string; active: boolean }[];
	/** Shows Restart to Update in the app menu. */
	updateReadyVersion: string | null;
	/**
	 * Undo and Redo act on the app's undo history (no text field has the
	 * keyboard) instead of being the native text-editing items.
	 */
	appUndo: boolean;
	/** "Undo Mark as Finished"; null disables Undo. */
	undoLabel: string | null;
	/** "Redo Mark as Finished"; null disables Redo. */
	redoLabel: string | null;
}

export interface MenuAdapter {
	/** Library > Add Book…. */
	onAddBook(handler: () => void): Promise<() => void>;
	/** Every other menu choice; never fires without a menu bar. */
	onCommand(handler: (command: MenuCommand) => void): Promise<() => void>;
	/** Fields left out keep their value; does nothing without a menu bar. */
	setState(state: Partial<MenuState>): Promise<void>;
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
	 * file extension. Null in a browser, off macOS, or when none claims it.
	 */
	defaultApp(path: string): Promise<DefaultApp | null>;
	/** Quick Look; only where `canQuickLook`. */
	quickLook(path: string): Promise<void>;
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
	 * dragstart; only where `canDragFilesOut`. Without an icon, the file
	 * manager's icon for the first file is shown.
	 */
	startDrag(files: string[], iconPath?: string): Promise<void>;
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
