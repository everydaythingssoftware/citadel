import { describe, expect, it } from "vitest";
import { type ShortcutGroup, shortcutGroups } from "@/lib/shortcut-list";

const keysOf = (groups: ShortcutGroup[], action: string) =>
	groups.flatMap((group) => group.rows).find((row) => row.action === action)
		?.keys;

const options = { fileManagerName: "Explorer", quickLook: false };

describe("shortcutGroups", () => {
	it("groups the Windows app's chords as Windows writes them", () => {
		const groups = shortcutGroups({ os: "windows", desktop: true }, options);
		expect(groups.map((group) => group.title)).toEqual([
			"Navigation",
			"Books",
			"Library",
			"App",
		]);
		expect(keysOf(groups, "Show or hide details")).toEqual([
			"Ctrl+I",
			"Alt+Enter",
		]);
		expect(keysOf(groups, "Back")).toEqual(["Alt+Left"]);
		expect(keysOf(groups, "Next sidebar item")).toEqual([
			"Ctrl+Page Down",
			"Ctrl+Tab",
		]);
		expect(keysOf(groups, "Previous sidebar item")).toEqual([
			"Ctrl+Page Up",
			"Ctrl+Shift+Tab",
		]);
		expect(keysOf(groups, "Go to sidebar section")).toEqual([
			"Ctrl+1",
			"Ctrl+9",
		]);
		expect(keysOf(groups, "Redo")).toEqual(["Ctrl+Shift+Z", "Ctrl+Y"]);
		expect(keysOf(groups, "Show in Explorer")).toEqual(["Ctrl+Shift+R"]);
		expect(keysOf(groups, "Close Settings")).toEqual(["Ctrl+W"]);
		expect(keysOf(groups, "Quick Look")).toBeUndefined();
	});

	it("lists the Mac menu bar's chords with its glyphs", () => {
		const groups = shortcutGroups(
			{ os: "macos", desktop: true },
			{ fileManagerName: "Finder", quickLook: true },
		);
		expect(keysOf(groups, "Show or hide details")).toEqual(["⌘I"]);
		expect(keysOf(groups, "Show in Finder")).toEqual(["⇧⌘R"]);
		expect(keysOf(groups, "Back")).toEqual(["⌘["]);
		expect(keysOf(groups, "Next sidebar item")).toEqual(["⌃⇥"]);
		expect(keysOf(groups, "Go to sidebar section")).toEqual(["⌘1", "⌘9"]);
		expect(keysOf(groups, "Quick Look")).toEqual(["Space"]);
		expect(keysOf(groups, "Full screen")).toBeUndefined();
	});

	it("leaves a browser its own chords", () => {
		const groups = shortcutGroups({ os: "windows", desktop: false }, options);
		expect(keysOf(groups, "Go to Authors")).toBeUndefined();
		expect(keysOf(groups, "Next sidebar item")).toBeUndefined();
		expect(keysOf(groups, "Show or hide details")).toEqual(["Ctrl+I"]);
		expect(keysOf(groups, "Find in the library")).toEqual(["Ctrl+F"]);
	});
});
