import type { GoDestination } from "@/bindings";
import { type EditableTargetLike, isEditableTarget } from "@/lib/keymap";

/**
 * The sidebar's items in display order, for the keys that walk it: the
 * library's sections (the Go menu's, ⌘1…5), then its shelves.
 */
export type SidebarItem =
	| { kind: "go"; go: GoDestination }
	| { kind: "shelf"; index: number };

export const SIDEBAR_SECTIONS: readonly GoDestination[] = [
	"allBooks",
	"authors",
	"series",
	"tags",
	"publishers",
];

export const sidebarItems = (shelfCount: number): SidebarItem[] => [
	...SIDEBAR_SECTIONS.map((go) => ({ kind: "go" as const, go })),
	...Array.from({ length: shelfCount }, (_, index) => ({
		kind: "shelf" as const,
		index,
	})),
];

/** The digit a sidebar item's shortcut uses (⌘1…⌘9), by display position. */
export const sidebarItemDigit = (position: number): number | null =>
	position >= 0 && position < 9 ? position + 1 : null;

const SECTION_PATHS: Record<string, GoDestination> = {
	"/": "allBooks",
	"/authors": "authors",
	"/series": "series",
	"/tags": "tags",
	"/publishers": "publishers",
};

/**
 * The item showing now, by display position, or -1 when none is (Settings).
 * A book opened from the grid still belongs to All Books.
 */
export const activeSidebarPosition = ({
	pathname,
	activeShelfIndex,
}: {
	pathname: string;
	/** The open shelf among the sidebar's, -1 when none is open. */
	activeShelfIndex: number;
}): number => {
	if (pathname === "/" && activeShelfIndex >= 0)
		return SIDEBAR_SECTIONS.length + activeShelfIndex;
	if (pathname.startsWith("/books/")) return 0;
	const section = SECTION_PATHS[pathname];
	return section === undefined ? -1 : SIDEBAR_SECTIONS.indexOf(section);
};

/**
 * The next (`step` 1) or previous (-1) item, wrapping at both ends; from
 * nowhere, the first or the last.
 */
export const stepSidebarPosition = (
	position: number,
	count: number,
	step: 1 | -1,
): number => {
	if (count <= 0) return -1;
	if (position < 0 || position >= count) return step > 0 ? 0 : count - 1;
	return (position + step + count) % count;
};

/** The key that reveals the sidebar's shortcut digits when held alone. */
export type HintModifier = "Control" | "Meta";

export interface ModifierKeyEvent {
	key: string;
	/** The physical key, for digit chords on layouts like AZERTY. */
	code?: string;
	repeat: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	target?: EditableTargetLike | null;
}

/**
 * Whether a key press starts the hold that reveals the digits: the modifier
 * pressed alone (no other modifier held), outside a field, where its
 * shortcuts work.
 */
export const startsHintHold = (
	event: ModifierKeyEvent,
	modifier: HintModifier,
): boolean =>
	event.key === modifier &&
	!event.repeat &&
	event.ctrlKey === (modifier === "Control") &&
	event.metaKey === (modifier === "Meta") &&
	!event.altKey &&
	!event.shiftKey &&
	!isEditableTarget(event.target);

const holdsModifier = (event: ModifierKeyEvent, modifier: HintModifier) =>
	(modifier === "Control" ? event.ctrlKey : event.metaKey) && !event.altKey;

/**
 * A press that keeps the digits showing while the modifier stays down: its
 * own auto-repeat, Shift on its way to ⇧Tab, and the chords that walk the
 * sidebar (modifier+digit; Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Up/Down),
 * so the person can hop items and watch where they land.
 */
export const continuesHintHold = (
	event: ModifierKeyEvent,
	modifier: HintModifier,
): boolean => {
	if (event.key === modifier) return event.repeat;
	if (!holdsModifier(event, modifier)) return false;
	if (event.key === "Shift") return true;
	if (/^Digit[1-9]$/.test(event.code ?? "") && !event.shiftKey) return true;
	if (modifier !== "Control") return false;
	if (event.key === "Tab") return true;
	return (
		(event.key === "PageUp" || event.key === "PageDown") && !event.shiftKey
	);
};

/**
 * A release that ends the hold: the modifier's own, or any key once the
 * modifier is no longer down. Releasing a walking chord's key does not.
 */
export const endsHintHold = (
	event: Pick<ModifierKeyEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
	modifier: HintModifier,
): boolean =>
	event.key === modifier ||
	!(modifier === "Control" ? event.ctrlKey : event.metaKey);
