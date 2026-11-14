/**
 * The pure half of the context menu (components/ui/ContextMenu.tsx): where it
 * opens, and which item arrow keys, Home/End and type-ahead land on.
 */

export interface ContextMenuItemEntry {
	type?: "item";
	id: string;
	label: string;
	onSelect: () => void;
	destructive?: boolean;
	disabled?: boolean;
	/** Defined for items that show a checkmark column; true draws the check. */
	checked?: boolean;
	/** A key equivalent shown at the right, e.g. "⌘I". Display only. */
	shortcut?: string;
	/** The same, spelled for `aria-keyshortcuts` ("Meta+I"). */
	keyShortcuts?: string;
}

export interface ContextMenuSeparatorEntry {
	type: "separator";
	id: string;
}

export type ContextMenuEntry = ContextMenuItemEntry | ContextMenuSeparatorEntry;

/** Anchored at viewport coordinates; null closes the menu. */
export interface ContextMenuState {
	x: number;
	y: number;
	items: ContextMenuEntry[];
	/** The menu's accessible name, e.g. "Book actions". */
	label?: string;
}

export const isMenuItem = (
	entry: ContextMenuEntry,
): entry is ContextMenuItemEntry => entry.type !== "separator";

const isNavigable = (
	entry: ContextMenuEntry | undefined,
): entry is ContextMenuItemEntry =>
	entry !== undefined && isMenuItem(entry) && !entry.disabled;

/**
 * Separators only between groups: none leading, trailing or doubled, which
 * lets callers build groups with conditional items without bookkeeping.
 */
export const tidyEntries = (entries: ContextMenuEntry[]): ContextMenuEntry[] =>
	entries.filter((entry, index, all) => {
		if (isMenuItem(entry)) return true;
		const before = all.slice(0, index);
		const after = all.slice(index + 1);
		const previous = before.at(-1);
		return (
			before.some(isMenuItem) &&
			after.some(isMenuItem) &&
			previous !== undefined &&
			isMenuItem(previous)
		);
	});

export type MenuMove = "next" | "previous" | "first" | "last";

/** The index a key moves the highlight to, wrapping like an NSMenu. */
export const moveHighlight = (
	entries: ContextMenuEntry[],
	current: number | null,
	move: MenuMove,
): number | null => {
	const count = entries.length;
	if (count === 0) return null;
	const scan = (start: number, step: 1 | -1): number | null => {
		for (let offset = 0; offset < count; offset++) {
			const index = (((start + step * offset) % count) + count) % count;
			if (isNavigable(entries[index])) return index;
		}
		return null;
	};
	switch (move) {
		case "first":
			return scan(0, 1);
		case "last":
			return scan(count - 1, -1);
		case "next":
			return scan(current === null ? 0 : current + 1, 1);
		case "previous":
			return scan(current === null ? count - 1 : current - 1, -1);
	}
};

/**
 * Type-ahead: the first enabled item whose label starts with what was
 * typed. Repeating one letter steps through the items that start with it.
 */
export const matchTypeahead = (
	entries: ContextMenuEntry[],
	query: string,
	current: number | null,
): number | null => {
	const needle = query.toLocaleLowerCase();
	if (needle.length === 0) return null;
	const repeated = [...needle].every((char) => char === needle[0]);
	const prefix = repeated ? needle.slice(0, 1) : needle;
	const count = entries.length;
	const start =
		current === null ? 0 : repeated ? current + 1 : Math.max(current, 0);
	for (let offset = 0; offset < count; offset++) {
		const index = (start + offset) % count;
		const entry = entries[index];
		if (
			isNavigable(entry) &&
			entry.label.toLocaleLowerCase().startsWith(prefix)
		)
			return index;
	}
	return null;
};

export interface MenuPlacementInput {
	x: number;
	y: number;
	width: number;
	height: number;
	viewportWidth: number;
	viewportHeight: number;
	margin?: number;
}

/**
 * Opens down and to the right of the pointer; flips to the left of it when
 * there's no room on the right, and slides up when there's none below, as
 * macOS context menus do.
 */
export const placeMenu = ({
	x,
	y,
	width,
	height,
	viewportWidth,
	viewportHeight,
	margin = 8,
}: MenuPlacementInput): { left: number; top: number } => {
	const fitsRight = x + width <= viewportWidth - margin;
	const left = fitsRight ? x : x - width;
	const top = Math.min(y, viewportHeight - height - margin);
	return {
		left: Math.max(margin, Math.min(left, viewportWidth - width - margin)),
		top: Math.max(margin, top),
	};
};
