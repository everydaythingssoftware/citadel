import { describe, expect, it } from "vitest";
import {
	ariaChord,
	bookShortcutHint,
	chordFromAccelerator,
	formatChord,
	menuBarOwnsChords,
	pageShortcuts,
	shortcutChord,
	windowShortcuts,
} from "./app-shortcuts";
import { BOOK_COMMAND } from "./book-menu";
import { none, some } from "./option";

const macApp = { os: "macos", desktop: true } as const;
const windowsApp = { os: "windows", desktop: true } as const;
const linuxApp = { os: "linux", desktop: true } as const;
const macBrowser = { os: "macos", desktop: false } as const;
const windowsBrowser = { os: "windows", desktop: false } as const;

const commandsOf = (env: Parameters<typeof pageShortcuts>[0]) =>
	pageShortcuts(env).map((shortcut) => shortcut.command);

describe("menuBarOwnsChords", () => {
	it("is the macOS app only", () => {
		expect(menuBarOwnsChords(macApp)).toBe(true);
		expect(menuBarOwnsChords(macBrowser)).toBe(false);
		expect(menuBarOwnsChords(windowsApp)).toBe(false);
	});
});

describe("pageShortcuts", () => {
	it("leaves every chord to the menu bar in the macOS app", () => {
		expect(pageShortcuts(macApp)).toEqual([]);
	});

	it("gives Windows and Linux the menu bar's chords, including Toggle Sidebar", () => {
		for (const env of [windowsApp, linuxApp]) {
			const commands = commandsOf(env);
			expect(commands).toContainEqual({ go: "allBooks" });
			expect(commands).toContainEqual({ go: "publishers" });
			expect(commands).toContain("book-open");
			expect(commands).toContain("add-book");
			expect(commands).toContain("open-settings");
			expect(commands).toContain("toggle-sidebar");
		}
	});

	it("keeps the browser's own chords in a browser", () => {
		for (const env of [macBrowser, windowsBrowser]) {
			const commands = commandsOf(env);
			expect([...new Set(commands)]).toEqual([
				"undo",
				"redo",
				"find",
				"book-show-details",
				"book-delete",
			]);
		}
	});

	it("binds Undo and Redo everywhere the page handles keys", () => {
		for (const env of [windowsApp, linuxApp, macBrowser, windowsBrowser]) {
			expect(shortcutChord("undo", env)).toEqual(some("mod+z"));
			expect(shortcutChord("redo", env)).toEqual(some("mod+shift+z"));
		}
		expect(commandsOf(macApp)).not.toContain("undo");
	});

	it("also redoes with Ctrl+Y on Windows and Linux, app or browser", () => {
		const redoChords = (env: Parameters<typeof pageShortcuts>[0]) =>
			pageShortcuts(env)
				.filter((shortcut) => shortcut.command === "redo")
				.map((shortcut) => shortcut.chord);
		for (const env of [windowsApp, linuxApp, windowsBrowser]) {
			expect(redoChords(env)).toEqual(["mod+shift+z", "mod+y"]);
		}
		expect(redoChords(macBrowser)).toEqual(["mod+shift+z"]);
	});

	it("goes back and forward with Alt+arrows on Windows and Linux desktop", () => {
		for (const env of [windowsApp, linuxApp]) {
			expect(shortcutChord("go-back", env)).toEqual(some("alt+arrowleft"));
			expect(shortcutChord("go-forward", env)).toEqual(some("alt+arrowright"));
		}
		expect(shortcutChord("go-back", macApp)).toEqual(some("mod+["));
		expect(shortcutChord("go-back", windowsBrowser)).toEqual(none());
		expect(shortcutChord("go-back", macBrowser)).toEqual(none());
	});

	it("shows details with Alt+Enter too on Windows and Linux desktop", () => {
		const detailsChords = (env: Parameters<typeof pageShortcuts>[0]) =>
			pageShortcuts(env)
				.filter((shortcut) => shortcut.command === "book-show-details")
				.map((shortcut) => shortcut.chord);
		expect(detailsChords(windowsApp)).toEqual(["mod+i", "alt+enter"]);
		expect(detailsChords(linuxApp)).toEqual(["mod+i", "alt+enter"]);
		expect(detailsChords(windowsBrowser)).toEqual(["mod+i"]);
		expect(detailsChords(macBrowser)).toEqual(["mod+i"]);
		expect(shortcutChord("book-show-details", windowsApp)).toEqual(
			some("mod+i"),
		);
	});

	it("deletes with the Delete key off macOS", () => {
		expect(shortcutChord("book-delete", windowsApp)).toEqual(some("delete"));
		expect(shortcutChord("book-delete", macBrowser)).toEqual(
			some("mod+backspace"),
		);
	});

	it("numbers Go the same everywhere it exists", () => {
		const go = pageShortcuts(windowsApp).flatMap(({ command, chord }) =>
			typeof command !== "string" && "go" in command
				? [[command.go, chord]]
				: [],
		);
		expect(go).toEqual([
			["allBooks", "mod+1"],
			["authors", "mod+2"],
			["series", "mod+3"],
			["tags", "mod+4"],
			["publishers", "mod+5"],
		]);
	});
});

describe("chordFromAccelerator", () => {
	it("reads the menu bar's accelerators as keymap chords", () => {
		expect(chordFromAccelerator("CmdOrCtrl+Shift+Z")).toBe("mod+shift+z");
		expect(chordFromAccelerator("Ctrl+Cmd+S")).toBe("ctrl+mod+s");
		expect(chordFromAccelerator("CmdOrCtrl+Backspace")).toBe("mod+backspace");
		expect(chordFromAccelerator("CmdOrCtrl+[")).toBe("mod+[");
	});
});

describe("formatChord", () => {
	it("uses symbols in Apple's order on macOS", () => {
		expect(formatChord("mod+i", "macos")).toBe("⌘I");
		expect(formatChord("mod+shift+r", "macos")).toBe("⇧⌘R");
		expect(formatChord("mod+backspace", "macos")).toBe("⌘⌫");
		expect(formatChord("mod+ctrl+s", "macos")).toBe("⌃⌘S");
	});

	it("spells modifiers out elsewhere", () => {
		expect(formatChord("mod+i", "windows")).toBe("Ctrl+I");
		expect(formatChord("mod+shift+r", "linux")).toBe("Ctrl+Shift+R");
		expect(formatChord("delete", "windows")).toBe("Delete");
		expect(formatChord("alt+arrowleft", "windows")).toBe("Alt+Left");
		expect(formatChord("alt+enter", "linux")).toBe("Alt+Enter");
	});
});

describe("ariaChord", () => {
	it("names keys the way aria-keyshortcuts expects", () => {
		expect(ariaChord("mod+shift+r", "macos")).toBe("Meta+Shift+R");
		expect(ariaChord("mod+i", "windows")).toBe("Control+I");
		expect(ariaChord("mod+backspace", "macos")).toBe("Meta+Backspace");
		expect(ariaChord("alt+arrowleft", "linux")).toBe("Alt+ArrowLeft");
	});
});

describe("bookShortcutHint", () => {
	it("shows the menu bar's chords in the macOS app", () => {
		expect(
			bookShortcutHint(BOOK_COMMAND.showDetails, macApp).value?.label,
		).toBe("⌘I");
		expect(
			bookShortcutHint(BOOK_COMMAND.showInFileManager, macApp).value?.label,
		).toBe("⇧⌘R");
		expect(bookShortcutHint(BOOK_COMMAND.quickLook, macApp).value?.label).toBe(
			"Space",
		);
	});

	it("shows Ctrl chords on Windows", () => {
		expect(bookShortcutHint(BOOK_COMMAND.open, windowsApp).value?.label).toBe(
			"Ctrl+O",
		);
		expect(bookShortcutHint(BOOK_COMMAND.delete, windowsApp).value?.label).toBe(
			"Delete",
		);
	});

	it("shows only the primary chord for Show Details", () => {
		expect(
			bookShortcutHint(BOOK_COMMAND.showDetails, windowsApp).value?.label,
		).toBe("Ctrl+I");
	});

	it("leaves out chords a browser keeps", () => {
		expect(bookShortcutHint(BOOK_COMMAND.edit, windowsBrowser).isSome).toBe(
			false,
		);
		expect(
			bookShortcutHint(BOOK_COMMAND.showDetails, macBrowser).value?.label,
		).toBe("⌘I");
	});

	it("has none for items without a chord", () => {
		expect(bookShortcutHint(BOOK_COMMAND.copyTitle, macApp).isSome).toBe(false);
		expect(bookShortcutHint(BOOK_COMMAND.toggleFinished, macApp).isSome).toBe(
			false,
		);
	});
});

it("binds sidebar and window actions only in the intended desktop windows", () => {
	for (const env of [windowsApp, linuxApp]) {
		expect(shortcutChord("toggle-sidebar", env)).toEqual(some("mod+shift+l"));
		expect(windowShortcuts(env, true)).toEqual([
			{ command: "toggle-fullscreen", chord: "f11" },
		]);
		expect(windowShortcuts(env, false)).toEqual([
			{ command: "close-settings", chord: "mod+w" },
		]);
		const chords = pageShortcuts(env).map(({ chord }) => chord);
		expect(chords.filter((chord) => chord === "mod+shift+l")).toHaveLength(1);
	}
	for (const env of [macApp, macBrowser, windowsBrowser]) {
		expect(windowShortcuts(env, true)).toEqual([]);
		expect(windowShortcuts(env, false)).toEqual([]);
	}
});
