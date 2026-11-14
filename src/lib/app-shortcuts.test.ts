import { describe, expect, it } from "vitest";
import {
	APP_COMMAND,
	ariaChord,
	bookShortcutHint,
	formatChord,
	menuBarOwnsChords,
	pageShortcuts,
	SHORTCUTS,
	shortcutChord,
} from "./app-shortcuts";
import { BOOK_COMMAND } from "./book-menu";

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

	it("gives Windows and Linux the menu bar's chords, minus Hide Sidebar", () => {
		for (const env of [windowsApp, linuxApp]) {
			const commands = commandsOf(env);
			expect(commands).toContain("go-all-books");
			expect(commands).toContain("go-publishers");
			expect(commands).toContain("book-open");
			expect(commands).toContain(APP_COMMAND.addBook);
			expect(commands).toContain(APP_COMMAND.openSettings);
			expect(commands).not.toContain("toggle-sidebar");
		}
	});

	it("keeps the browser's own chords in a browser", () => {
		for (const env of [macBrowser, windowsBrowser]) {
			const commands = commandsOf(env);
			expect(commands).toEqual([
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
			expect(shortcutChord("undo", env)).toBe("mod+z");
			expect(shortcutChord("redo", env)).toBe("mod+shift+z");
		}
		expect(commandsOf(macApp)).not.toContain("undo");
	});

	it("deletes with the Delete key off macOS", () => {
		expect(shortcutChord("book-delete", windowsApp)).toBe("delete");
		expect(shortcutChord("book-delete", macBrowser)).toBe("mod+backspace");
	});

	it("numbers Go the same everywhere it exists", () => {
		const go = SHORTCUTS.filter((shortcut) =>
			shortcut.command.startsWith("go-"),
		).map((shortcut) => [shortcut.command, shortcut.chord]);
		expect(go.slice(0, 5)).toEqual([
			["go-all-books", "mod+1"],
			["go-authors", "mod+2"],
			["go-series", "mod+3"],
			["go-tags", "mod+4"],
			["go-publishers", "mod+5"],
		]);
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
	});
});

describe("ariaChord", () => {
	it("names keys the way aria-keyshortcuts expects", () => {
		expect(ariaChord("mod+shift+r", "macos")).toBe("Meta+Shift+R");
		expect(ariaChord("mod+i", "windows")).toBe("Control+I");
		expect(ariaChord("mod+backspace", "macos")).toBe("Meta+Backspace");
	});
});

describe("bookShortcutHint", () => {
	it("shows the menu bar's chords in the macOS app", () => {
		expect(bookShortcutHint(BOOK_COMMAND.showDetails, macApp)?.label).toBe(
			"⌘I",
		);
		expect(
			bookShortcutHint(BOOK_COMMAND.showInFileManager, macApp)?.label,
		).toBe("⇧⌘R");
		expect(bookShortcutHint(BOOK_COMMAND.quickLook, macApp)?.label).toBe(
			"Space",
		);
	});

	it("shows Ctrl chords on Windows", () => {
		expect(bookShortcutHint(BOOK_COMMAND.open, windowsApp)?.label).toBe(
			"Ctrl+O",
		);
		expect(bookShortcutHint(BOOK_COMMAND.delete, windowsApp)?.label).toBe(
			"Delete",
		);
	});

	it("leaves out chords a browser keeps", () => {
		expect(bookShortcutHint(BOOK_COMMAND.edit, windowsBrowser)).toBeNull();
		expect(bookShortcutHint(BOOK_COMMAND.showDetails, macBrowser)?.label).toBe(
			"⌘I",
		);
	});

	it("has none for items without a chord", () => {
		expect(bookShortcutHint(BOOK_COMMAND.copyTitle, macApp)).toBeNull();
		expect(bookShortcutHint(BOOK_COMMAND.toggleFinished, macApp)).toBeNull();
	});
});
