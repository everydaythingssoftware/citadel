import type { EditableTargetLike, KeyBinding } from "@/lib/keymap";
import { createKeymapHandler } from "@/lib/keymap";
import { useEffect, useRef } from "react";

export interface KeymapOptions {
	/**
	 * Listen in the window's capture phase, before any element (or Radix's
	 * document-level layer stack) sees the key: for bindings whose turn
	 * must not depend on which layer is on top, like Escape closing the
	 * details panel while a tooltip shows.
	 */
	capture?: boolean;
}

/**
 * One key press, one action: once a keymap acts on an event, the others
 * leave it alone, even when the action re-rendered them in time to match
 * it again (Escape closing the details must not also clear the selection).
 */
const handledEvents = new WeakSet<KeyboardEvent>();

export const useKeymap = (
	bindings: KeyBinding[],
	{ capture = false }: KeymapOptions = {},
) => {
	const bindingsRef = useRef(bindings);
	bindingsRef.current = bindings;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (handledEvents.has(event)) return;
			const handler = createKeymapHandler(bindingsRef.current);
			const handled = handler({
				key: event.key,
				metaKey: event.metaKey,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				target: event.target as EditableTargetLike | null,
				preventDefault: () => event.preventDefault(),
			});
			if (handled) handledEvents.add(event);
		};
		window.addEventListener("keydown", onKeyDown, capture);
		return () => window.removeEventListener("keydown", onKeyDown, capture);
	}, [capture]);
};
