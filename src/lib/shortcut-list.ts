import type { GoDestination } from "@/bindings";
import {
	boundShortcuts,
	formatChord,
	type ShortcutEnvironment,
	shelfShortcuts,
	sidebarStepShortcuts,
	type TShortcutCommand,
	windowShortcuts,
} from "@/lib/app-shortcuts";
import { revealLabel } from "@/lib/book-file-actions";

/** ⌘S / Ctrl+S in the book editor, on every platform. */
export const EDITOR_SAVE_CHORD = "mod+s";

/** One row of the shortcuts list: what it does, and the keys that do it. */
export interface ShortcutRow {
	action: string;
	/** Each chord as this platform writes it ("⇧⌘R", "Ctrl+Shift+R"). */
	keys: string[];
	/** "to" for a run of digits (⌘6 to ⌘9); otherwise any of them works. */
	joiner: "or" | "to";
}

export interface ShortcutGroup {
	title: string;
	rows: ShortcutRow[];
}

const GO_LABELS: Record<GoDestination, string> = {
	allBooks: "All Books",
	authors: "Authors",
	series: "Series",
	tags: "Tags",
	publishers: "Publishers",
};

type TCommandName = Extract<TShortcutCommand, string>;

const COMMAND_LABELS: Partial<Record<TCommandName, string>> = {
	"add-book": "Add book…",
	undo: "Undo",
	redo: "Redo",
	find: "Find in the library",
	"book-show-details": "Show or hide details",
	"book-open": "Open the book’s file",
	"book-edit": "Edit the book…",
	"book-delete": "Delete selected books…",
	"toggle-sidebar": "Show or hide the sidebar",
	"go-back": "Back",
	"go-forward": "Forward",
	"open-settings": "Settings…",
};

const GROUP_OF: Partial<Record<TCommandName, string>> = {
	"go-back": "Navigation",
	"go-forward": "Navigation",
	"book-show-details": "Books",
	"book-open": "Books",
	"book-edit": "Books",
	"book-show-in-file-manager": "Books",
	"book-delete": "Books",
	"add-book": "Library",
	find: "Library",
	undo: "Library",
	redo: "Library",
	"toggle-sidebar": "App",
	"open-settings": "App",
};

const GROUP_ORDER = ["Navigation", "Books", "Library", "App"] as const;
type TGroupTitle = (typeof GROUP_ORDER)[number];

interface ListedRow {
	group: TGroupTitle;
	action: string;
	chords: string[];
	joiner?: "or" | "to";
}

const commandKey = (command: TShortcutCommand): string =>
	typeof command === "string" ? command : JSON.stringify(command);

const commandLabel = (
	command: TShortcutCommand,
	fileManagerName: string,
): string | undefined => {
	if (typeof command !== "string")
		return "go" in command ? `Go to ${GO_LABELS[command.go]}` : undefined;
	if (command === "book-show-in-file-manager")
		return revealLabel(fileManagerName);
	return COMMAND_LABELS[command];
};

const commandGroup = (command: TShortcutCommand): TGroupTitle | undefined => {
	if (typeof command !== "string")
		return "go" in command ? "Navigation" : undefined;
	const group = GROUP_OF[command];
	return GROUP_ORDER.find((title) => title === group);
};

/**
 * Every shortcut that works on this platform, grouped for Settings. Built
 * from the tables that bind them (the menu bar's accelerators and
 * `app-shortcuts.ts`), so the list can't promise a key that does nothing.
 * Keys that belong to one page (the grid's arrows, Return, Escape, the
 * editor's save) are written out here, beside what binds them.
 */
export const shortcutGroups = (
	env: ShortcutEnvironment,
	{
		fileManagerName,
		quickLook,
	}: { fileManagerName: string; quickLook: boolean },
): ShortcutGroup[] => {
	// One row per command, its primary chord first (Ctrl+Y after Ctrl+Shift+Z).
	const byCommand = new Map<string, ListedRow>();
	for (const { command, chord } of boundShortcuts(env)) {
		const key = commandKey(command);
		const listed = byCommand.get(key);
		if (listed !== undefined) {
			listed.chords.push(chord);
			continue;
		}
		const group = commandGroup(command);
		const action = commandLabel(command, fileManagerName);
		if (group !== undefined && action !== undefined)
			byCommand.set(key, { group, action, chords: [chord] });
	}
	const menuRows = [...byCommand.values()];
	const goRows = menuRows.filter(
		(row) => row.group === "Navigation" && row.action.startsWith("Go to"),
	);
	const historyRows = menuRows.filter(
		(row) => row.group === "Navigation" && !goRows.includes(row),
	);

	const shelves = shelfShortcuts(env);
	const lastShelf = shelves.at(-1);
	const steps = sidebarStepShortcuts(env);
	const stepRow = (step: 1 | -1, action: string): ListedRow[] => {
		const chords = steps
			.filter((shortcut) => shortcut.step === step)
			.map((shortcut) => shortcut.chord);
		return chords.length > 0 ? [{ group: "Navigation", action, chords }] : [];
	};

	// One row for the whole run: sections, then shelves (⌘1 to ⌘9).
	const firstGo = goRows[0]?.chords[0];
	const lastGo = lastShelf?.chord ?? goRows.at(-1)?.chords[0];
	const rows: ListedRow[] = [
		...(firstGo !== undefined && lastGo !== undefined
			? [
					{
						group: "Navigation" as const,
						action: "Go to sidebar section",
						chords: [firstGo, lastGo],
						joiner: "to" as const,
					},
				]
			: goRows),
		...stepRow(1, "Next sidebar item"),
		...stepRow(-1, "Previous sidebar item"),
		...historyRows,
		...menuRows.filter((row) => row.group === "Books"),
		{ group: "Books", action: "Show details", chords: ["enter"] },
		{
			group: "Books",
			action: "Move the selection",
			chords: ["arrowup", "arrowdown", "arrowleft", "arrowright"],
		},
		{
			group: "Books",
			action: "Extend the selection",
			chords: ["shift+arrowup", "shift+arrowdown"],
		},
		{ group: "Books", action: "Select all", chords: ["mod+a"] },
		...(quickLook
			? [{ group: "Books" as const, action: "Quick Look", chords: ["space"] }]
			: []),
		{
			group: "Books",
			action: "Close details, then clear the selection",
			chords: ["escape"],
		},
		{
			group: "Books",
			action: "Save the book’s edits",
			chords: [EDITOR_SAVE_CHORD],
		},
		...menuRows.filter((row) => row.group === "Library"),
		{ group: "Library", action: "Clear the search field", chords: ["escape"] },
		...menuRows.filter((row) => row.group === "App"),
		...windowShortcuts(env, true).map(
			({ chord }): ListedRow => ({
				group: "App",
				action: "Full screen",
				chords: [chord],
			}),
		),
		{
			group: "App",
			action: "Close Settings",
			chords: windowShortcuts(env, false).map(({ chord }) => chord),
		},
	];

	return GROUP_ORDER.map((title) => ({
		title,
		rows: rows
			.filter((row) => row.group === title)
			.map((row) => ({
				action: row.action,
				keys: row.chords.map((chord) => formatChord(chord, env.os)),
				joiner: row.joiner ?? "or",
			})),
	})).filter((group) => group.rows.length > 0);
};
