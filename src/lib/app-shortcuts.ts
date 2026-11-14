import type { TBookCommand } from "@/lib/book-menu";
import { BOOK_COMMAND } from "@/lib/book-menu";
import type { MenuCommand } from "@/lib/platform/types";
import type { OperatingSystem } from "@/lib/platform/os";

/** Where a shortcut is pressed: which OS, and the app or a browser tab. */
export interface ShortcutEnvironment {
	os: OperatingSystem;
	desktop: boolean;
}

/**
 * The macOS app has a menu bar whose items carry these chords; there the
 * menu is the one place each chord is handled, and the page must leave it
 * alone so it isn't run twice.
 */
export const menuBarOwnsChords = ({ os, desktop }: ShortcutEnvironment) =>
	desktop && os === "macos";

/** Keyboard commands that aren't menu commands. */
export const APP_COMMAND = {
	addBook: "add-book",
	openSettings: "open-settings",
} as const;

export type TAppCommand = (typeof APP_COMMAND)[keyof typeof APP_COMMAND];

export type TShortcutCommand = MenuCommand | TAppCommand;

/** Where a chord applies besides the macOS menu bar. */
const SCOPE = {
	/** Windows and Linux desktop, and every browser. */
	everywhere: "everywhere",
	/** Windows and Linux desktop only: a browser keeps the chord for itself. */
	desktopOnly: "desktop-only",
	/** Only the macOS menu bar has it. */
	menuOnly: "menu-only",
} as const;

type TScope = (typeof SCOPE)[keyof typeof SCOPE];

interface ShortcutDefinition {
	command: Exclude<TShortcutCommand, { switchLibrary: string }>;
	/** `keymap.ts` chord syntax; `mod` is ⌘ on macOS and Ctrl elsewhere. */
	chord: string;
	/** Off macOS, where this chord differs (Delete instead of ⌘⌫). */
	otherChord?: string;
	scope: TScope;
}

/**
 * Every app-wide shortcut, matching the macOS menu bar
 * (`src-tauri/src/menu/bar.rs`). In a browser, chords the browser itself
 * uses (Ctrl+O, Ctrl+N, Ctrl+1…, ⇧⌘R, Ctrl+E) stay the browser's.
 */
export const SHORTCUTS: readonly ShortcutDefinition[] = [
	{ command: "undo", chord: "mod+z", scope: SCOPE.everywhere },
	{ command: "redo", chord: "mod+shift+z", scope: SCOPE.everywhere },
	{ command: "find", chord: "mod+f", scope: SCOPE.everywhere },
	{ command: "go-all-books", chord: "mod+1", scope: SCOPE.desktopOnly },
	{ command: "go-authors", chord: "mod+2", scope: SCOPE.desktopOnly },
	{ command: "go-series", chord: "mod+3", scope: SCOPE.desktopOnly },
	{ command: "go-tags", chord: "mod+4", scope: SCOPE.desktopOnly },
	{ command: "go-publishers", chord: "mod+5", scope: SCOPE.desktopOnly },
	{ command: "go-back", chord: "mod+[", scope: SCOPE.desktopOnly },
	{ command: "go-forward", chord: "mod+]", scope: SCOPE.desktopOnly },
	{ command: "book-show-details", chord: "mod+i", scope: SCOPE.everywhere },
	{ command: "book-open", chord: "mod+o", scope: SCOPE.desktopOnly },
	{ command: "book-edit", chord: "mod+e", scope: SCOPE.desktopOnly },
	{
		command: "book-show-in-file-manager",
		chord: "mod+shift+r",
		scope: SCOPE.desktopOnly,
	},
	{
		command: "book-delete",
		chord: "mod+backspace",
		otherChord: "delete",
		scope: SCOPE.everywhere,
	},
	{ command: "toggle-sidebar", chord: "mod+ctrl+s", scope: SCOPE.menuOnly },
	{ command: APP_COMMAND.addBook, chord: "mod+n", scope: SCOPE.desktopOnly },
	{
		command: APP_COMMAND.openSettings,
		chord: "mod+,",
		scope: SCOPE.desktopOnly,
	},
];

const chordFor = (
	definition: ShortcutDefinition,
	os: OperatingSystem,
): string =>
	os !== "macos" && definition.otherChord !== undefined
		? definition.otherChord
		: definition.chord;

const appliesIn = (scope: TScope, env: ShortcutEnvironment): boolean => {
	if (menuBarOwnsChords(env)) return true;
	if (scope === SCOPE.menuOnly) return false;
	return scope === SCOPE.everywhere || env.desktop;
};

/** The chord for a command here, or null where it has none. */
export const shortcutChord = (
	command: TShortcutCommand,
	env: ShortcutEnvironment,
): string | null => {
	if (typeof command !== "string") return null;
	const definition = SHORTCUTS.find(
		(candidate) => candidate.command === command,
	);
	if (definition === undefined || !appliesIn(definition.scope, env))
		return null;
	return chordFor(definition, env.os);
};

/** Chords the page itself must handle: none the menu bar already does. */
export const pageShortcuts = (
	env: ShortcutEnvironment,
): { command: ShortcutDefinition["command"]; chord: string }[] =>
	menuBarOwnsChords(env)
		? []
		: SHORTCUTS.filter((definition) => appliesIn(definition.scope, env)).map(
				(definition) => ({
					command: definition.command,
					chord: chordFor(definition, env.os),
				}),
			);

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
	ctrl: "⌃",
	alt: "⌥",
	shift: "⇧",
	mod: "⌘",
};
const MAC_MODIFIER_ORDER = ["ctrl", "alt", "shift", "mod"];
const OTHER_MODIFIER_NAMES: Record<string, string> = {
	mod: "Ctrl",
	ctrl: "Ctrl",
	shift: "Shift",
	alt: "Alt",
};
const OTHER_MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"];

const MAC_KEY_SYMBOLS: Record<string, string> = {
	backspace: "⌫",
	delete: "⌦",
	enter: "↩",
	escape: "⎋",
	space: "Space",
};
const OTHER_KEY_NAMES: Record<string, string> = {
	backspace: "Backspace",
	delete: "Delete",
	enter: "Enter",
	escape: "Esc",
	space: "Space",
};

/** "⇧⌘R" on macOS, "Ctrl+Shift+R" elsewhere, for menus to show. */
export const formatChord = (chord: string, os: OperatingSystem): string => {
	const parts = chord.toLowerCase().split("+");
	const key = parts.at(-1) ?? "";
	const modifiers = new Set(parts.slice(0, -1));
	if (os === "macos" || os === "ios") {
		const symbols = MAC_MODIFIER_ORDER.filter((name) => modifiers.has(name))
			.map((name) => MAC_MODIFIER_SYMBOLS[name])
			.join("");
		return `${symbols}${MAC_KEY_SYMBOLS[key] ?? key.toUpperCase()}`;
	}
	const names = [
		...new Set(
			OTHER_MODIFIER_ORDER.filter((name) => modifiers.has(name)).map(
				(name) => OTHER_MODIFIER_NAMES[name],
			),
		),
	];
	return [...names, OTHER_KEY_NAMES[key] ?? key.toUpperCase()].join("+");
};

/** The `aria-keyshortcuts` spelling: "Meta+Shift+R", "Control+I". */
export const ariaChord = (chord: string, os: OperatingSystem): string => {
	const parts = chord.toLowerCase().split("+");
	const key = parts.at(-1) ?? "";
	const mac = os === "macos" || os === "ios";
	const modifiers = parts.slice(0, -1).map((name) => {
		if (name === "mod") return mac ? "Meta" : "Control";
		if (name === "ctrl") return "Control";
		return name.charAt(0).toUpperCase() + name.slice(1);
	});
	const keyName =
		key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
	return [...new Set(modifiers), keyName].join("+");
};

const BOOK_SHORTCUT_COMMANDS: Partial<Record<TBookCommand, MenuCommand>> = {
	[BOOK_COMMAND.showDetails]: "book-show-details",
	[BOOK_COMMAND.open]: "book-open",
	[BOOK_COMMAND.edit]: "book-edit",
	[BOOK_COMMAND.showInFileManager]: "book-show-in-file-manager",
	[BOOK_COMMAND.delete]: "book-delete",
};

export interface ShortcutHint {
	/** What the menu shows, e.g. "⌘I" or "Ctrl+I". */
	label: string;
	/** For `aria-keyshortcuts`. */
	aria: string;
}

/**
 * The key equivalent a book menu item shows, only where pressing it works
 * on this platform. Quick Look is Space wherever it exists.
 */
export const bookShortcutHint = (
	command: TBookCommand,
	env: ShortcutEnvironment,
): ShortcutHint | null => {
	if (command === BOOK_COMMAND.quickLook)
		return { label: "Space", aria: "Space" };
	const menuCommand = BOOK_SHORTCUT_COMMANDS[command];
	if (menuCommand === undefined) return null;
	const chord = shortcutChord(menuCommand, env);
	return chord === null
		? null
		: { label: formatChord(chord, env.os), aria: ariaChord(chord, env.os) };
};
