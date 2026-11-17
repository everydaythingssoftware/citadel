import { MENU_ACCELERATORS } from "@/bindings";
import type { TBookCommand } from "@/lib/book-menu";
import { BOOK_COMMAND } from "@/lib/book-menu";
import { usesCommandKey } from "@/lib/keymap";
import { none, type Option, some } from "@/lib/option";
import type { OperatingSystem } from "@/lib/platform/os";
import type { MenuCommand, PlatformAdapter } from "@/lib/platform/types";

/** Where a shortcut is pressed: which OS, and the app or a browser tab. */
export interface ShortcutEnvironment {
	os: OperatingSystem;
	desktop: boolean;
}

export const shortcutEnvironment = (
	platform: PlatformAdapter,
): ShortcutEnvironment => ({
	os: platform.os,
	desktop: platform.capabilities.supportsNativeWindows,
});

/**
 * The macOS app has a menu bar whose items carry these chords; there the
 * menu is the one place each chord is handled, and the page must leave it
 * alone so it isn't run twice.
 */
export const menuBarOwnsChords = ({ os, desktop }: ShortcutEnvironment) =>
	desktop && os === "macos";

/** Settings… is the native menu item; elsewhere it is only a shortcut. */
export type TShortcutCommand = MenuCommand | "open-settings";

type TNamedCommand = Extract<TShortcutCommand, string>;

export interface Shortcut {
	command: TShortcutCommand;
	/** `keymap.ts` chord syntax; `mod` is ⌘ on macOS and Ctrl elsewhere. */
	chord: string;
}

/** "CmdOrCtrl+Shift+Z" (a Tauri accelerator) as "mod+shift+z". */
export const chordFromAccelerator = (accelerator: string): string =>
	accelerator
		.toLowerCase()
		.split("+")
		.map((part) => (part === "cmdorctrl" || part === "cmd" ? "mod" : part))
		.join("+");

/** The menu bar's chords, as `src-tauri/src/menu/model.rs` defines them. */
const MENU_SHORTCUTS: readonly Shortcut[] = [
	...MENU_ACCELERATORS.commands.map(([command, accelerator]) => ({
		command,
		chord: chordFromAccelerator(accelerator),
	})),
	{
		command: "open-settings",
		chord: chordFromAccelerator(MENU_ACCELERATORS.settings),
	},
];

/** The chords a browser tab binds; it keeps the rest (Ctrl+O, Ctrl+1…). */
const IN_BROWSER: readonly TNamedCommand[] = [
	"undo",
	"redo",
	"find",
	"book-show-details",
	"book-delete",
];

/** Off Apple keyboards: Windows and Linux's own chord instead of the Mac's. */
const OFF_MAC_CHORD: Partial<Record<TNamedCommand, string>> = {
	"toggle-sidebar": "mod+shift+l",
	"go-back": "alt+arrowleft",
	"go-forward": "alt+arrowright",
	"book-delete": "delete",
};

/**
 * Further chords Windows and Linux also accept, by their own convention
 * (Ctrl+Y for Redo, Alt+Enter for Properties). Menus show only the first.
 */
const OFF_MAC_EXTRAS: readonly (Shortcut & { inBrowser: boolean })[] = [
	{ command: "redo", chord: "mod+y", inBrowser: true },
	{ command: "book-show-details", chord: "alt+enter", inBrowser: false },
];

const named = (
	command: TShortcutCommand,
	list: readonly TNamedCommand[],
): boolean => typeof command === "string" && list.includes(command);

const boundHere = (command: TShortcutCommand, env: ShortcutEnvironment) =>
	menuBarOwnsChords(env) || env.desktop || named(command, IN_BROWSER);

const chordHere = ({ command, chord }: Shortcut, os: OperatingSystem) =>
	(!usesCommandKey(os) && typeof command === "string"
		? OFF_MAC_CHORD[command]
		: undefined) ?? chord;

/** The chord a named command has here, where it has one. */
export const shortcutChord = (
	command: TNamedCommand | TBookCommand,
	env: ShortcutEnvironment,
): Option<string> => {
	const shortcut = MENU_SHORTCUTS.find(
		(candidate) => candidate.command === command,
	);
	return shortcut !== undefined && boundHere(shortcut.command, env)
		? some(chordHere(shortcut, env.os))
		: none();
};

/** Chords the page itself must handle: none the menu bar already does. */
export const pageShortcuts = (env: ShortcutEnvironment): Shortcut[] => {
	if (menuBarOwnsChords(env)) return [];
	const extras = usesCommandKey(env.os)
		? []
		: OFF_MAC_EXTRAS.filter((extra) => env.desktop || extra.inBrowser);
	return MENU_SHORTCUTS.filter(({ command }) =>
		boundHere(command, env),
	).flatMap((shortcut) => [
		{ command: shortcut.command, chord: chordHere(shortcut, env.os) },
		...extras
			.filter((extra) => extra.command === shortcut.command)
			.map(({ command, chord }) => ({ command, chord })),
	]);
};

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
	arrowleft: "←",
	arrowright: "→",
	arrowup: "↑",
	arrowdown: "↓",
};
const OTHER_KEY_NAMES: Record<string, string> = {
	backspace: "Backspace",
	delete: "Delete",
	enter: "Enter",
	escape: "Esc",
	space: "Space",
	arrowleft: "Left",
	arrowright: "Right",
	arrowup: "Up",
	arrowdown: "Down",
};

/** "⇧⌘R" on macOS, "Ctrl+Shift+R" elsewhere, for menus to show. */
export const formatChord = (chord: string, os: OperatingSystem): string => {
	const parts = chord.toLowerCase().split("+");
	const key = parts.at(-1) ?? "";
	const modifiers = new Set(parts.slice(0, -1));
	if (usesCommandKey(os)) {
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

const ARIA_KEY_NAMES: Record<string, string> = {
	arrowleft: "ArrowLeft",
	arrowright: "ArrowRight",
	arrowup: "ArrowUp",
	arrowdown: "ArrowDown",
};

/** The `aria-keyshortcuts` spelling: "Meta+Shift+R", "Control+I". */
export const ariaChord = (chord: string, os: OperatingSystem): string => {
	const parts = chord.toLowerCase().split("+");
	const key = parts.at(-1) ?? "";
	const mac = usesCommandKey(os);
	const modifiers = parts.slice(0, -1).map((name) => {
		if (name === "mod") return mac ? "Meta" : "Control";
		if (name === "ctrl") return "Control";
		return name.charAt(0).toUpperCase() + name.slice(1);
	});
	const keyName =
		ARIA_KEY_NAMES[key] ??
		(key.length === 1
			? key.toUpperCase()
			: key[0]?.toUpperCase() + key.slice(1));
	return [...new Set(modifiers), keyName].join("+");
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
): Option<ShortcutHint> => {
	if (command === BOOK_COMMAND.quickLook)
		return some({ label: "Space", aria: "Space" });
	const chord = shortcutChord(command, env);
	return chord.isSome
		? some({
				label: formatChord(chord.value, env.os),
				aria: ariaChord(chord.value, env.os),
			})
		: none();
};

interface WindowShortcut {
	command: "toggle-fullscreen" | "close-settings";
	chord: string;
}

export const windowShortcuts = (
	env: ShortcutEnvironment,
	isMain: boolean,
): WindowShortcut[] =>
	!env.desktop || env.os === "macos"
		? []
		: isMain
			? [{ command: "toggle-fullscreen", chord: "f11" }]
			: [{ command: "close-settings", chord: "mod+w" }];
