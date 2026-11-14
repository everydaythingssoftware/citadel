import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ContextMenuEntry,
	type ContextMenuState,
	isMenuItem,
	type MenuMove,
	matchTypeahead,
	moveHighlight,
	placeMenu,
	tidyEntries,
} from "@/lib/context-menu";

/** Long enough to fade out; the CSS animation is a touch shorter. */
const DISMISS_MS = 150;
const TYPEAHEAD_RESET_MS = 600;

const MOVE_KEYS: Record<string, MenuMove> = {
	ArrowDown: "next",
	ArrowUp: "previous",
	Home: "first",
	End: "last",
	PageUp: "first",
	PageDown: "last",
};

/**
 * Whether the last thing the person did was press a key: a menu opened
 * from the keyboard (Shift-F10, the Menu key) highlights its first item, one
 * opened with the pointer highlights nothing, as on macOS.
 */
let lastInputWasKeyboard = false;
let modalityTracked = false;
const trackInputModality = () => {
	if (modalityTracked || typeof document === "undefined") return;
	modalityTracked = true;
	document.addEventListener(
		"keydown",
		() => {
			lastInputWasKeyboard = true;
		},
		true,
	);
	document.addEventListener(
		"pointerdown",
		() => {
			lastInputWasKeyboard = false;
		},
		true,
	);
};

export interface ContextMenuSurfaceOptions {
	menu: ContextMenuState | null;
	returnFocusRef?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
}

export interface ContextMenuSurface {
	/** What to draw: the open menu, or the one fading out. */
	shown: ContextMenuState | null;
	entries: ContextMenuEntry[];
	closing: boolean;
	position: { left: number; top: number } | null;
	highlighted: number | null;
	hasCheckColumn: boolean;
	menuRef: React.RefObject<HTMLDivElement | null>;
	itemDomId: (entry: ContextMenuEntry) => string;
	onMenuKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
	onMenuPointerLeave: () => void;
	onItemPointerMove: (index: number) => void;
	activate: (index: number) => void;
}

/**
 * Behaviour behind components/ui/ContextMenu: placement, highlight by
 * pointer, arrows and type-ahead, dismissal, and a short fade on close.
 */
export const useContextMenuSurface = ({
	menu,
	returnFocusRef,
	onClose,
}: ContextMenuSurfaceOptions): ContextMenuSurface => {
	trackInputModality();
	const menuRef = useRef<HTMLDivElement>(null);
	const domId = useId();
	const [fading, setFading] = useState<ContextMenuState | null>(null);
	const [position, setPosition] = useState<{
		left: number;
		top: number;
	} | null>(null);
	const [highlighted, setHighlighted] = useState<number | null>(null);
	const typeahead = useRef({ query: "", at: 0 });
	const previous = useRef<ContextMenuState | null>(null);

	const shown = menu ?? fading;
	const entries = useMemo(
		() => (shown ? tidyEntries(shown.items) : []),
		[shown],
	);
	const hasCheckColumn = entries.some(
		(entry) => isMenuItem(entry) && entry.checked !== undefined,
	);

	useLayoutEffect(() => {
		const last = previous.current;
		previous.current = menu;
		if (menu) {
			setFading(null);
			return;
		}
		if (!last) return;
		setFading(last);
		const timer = setTimeout(() => {
			setFading(null);
			setPosition(null);
		}, DISMISS_MS);
		return () => clearTimeout(timer);
	}, [menu]);

	// Measured after render, before paint, so the menu lands in place with no
	// flicker; it renders hidden until then.
	useLayoutEffect(() => {
		if (!menu) return;
		const rect = menuRef.current?.getBoundingClientRect();
		if (!rect) return;
		setPosition(
			placeMenu({
				x: menu.x,
				y: menu.y,
				width: rect.width,
				height: rect.height,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight,
			}),
		);
		const opened = tidyEntries(menu.items);
		setHighlighted(
			lastInputWasKeyboard ? moveHighlight(opened, null, "first") : null,
		);
		typeahead.current = { query: "", at: 0 };
	}, [menu]);

	// Once placed (a hidden element can't take focus), the menu takes the
	// keyboard: arrows, type-ahead, Return and Escape all go to it.
	const placed = position !== null;
	useLayoutEffect(() => {
		if (menu && placed) menuRef.current?.focus({ preventScroll: true });
	}, [menu, placed]);

	useEffect(() => {
		if (!menu) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			onClose();
			returnFocusRef?.current?.focus();
		};
		const dismiss = () => onClose();
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("blur", dismiss);
		window.addEventListener("resize", dismiss);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("blur", dismiss);
			window.removeEventListener("resize", dismiss);
		};
	}, [menu, onClose, returnFocusRef]);

	const activate = useCallback(
		(index: number) => {
			const entry = entries[index];
			if (!menu || !entry || !isMenuItem(entry) || entry.disabled) return;
			onClose();
			returnFocusRef?.current?.focus();
			entry.onSelect();
		},
		[entries, menu, onClose, returnFocusRef],
	);

	const onMenuKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		if (!menu) return;
		const move = MOVE_KEYS[event.key];
		if (move) {
			event.preventDefault();
			setHighlighted((current) => moveHighlight(entries, current, move));
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (event.key === " " && typeahead.current.query) {
				typeahead.current.query += " ";
				return;
			}
			if (highlighted !== null) activate(highlighted);
			return;
		}
		if (event.key === "Tab") {
			event.preventDefault();
			return;
		}
		if (
			event.key.length === 1 &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			const now = event.timeStamp;
			const state = typeahead.current;
			state.query =
				now - state.at > TYPEAHEAD_RESET_MS
					? event.key
					: state.query + event.key;
			state.at = now;
			const match = matchTypeahead(entries, state.query, highlighted);
			if (match !== null) setHighlighted(match);
		}
	};

	const onItemPointerMove = (index: number) => {
		const entry = entries[index];
		const enabled = entry && isMenuItem(entry) && !entry.disabled;
		setHighlighted(enabled ? index : null);
	};

	return {
		shown,
		entries,
		closing: !menu && fading !== null,
		position,
		highlighted,
		hasCheckColumn,
		menuRef,
		itemDomId: (entry) => `${domId}-${entry.id}`,
		onMenuKeyDown,
		onMenuPointerLeave: () => setHighlighted(null),
		onItemPointerMove,
		activate,
	};
};
