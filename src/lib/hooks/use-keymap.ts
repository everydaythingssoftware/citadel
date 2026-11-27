import { useEffect, useRef } from "react";
import { browserGuardedEvents } from "@/lib/chrome-guards";
import type { EditableTargetLike, KeyBinding } from "@/lib/keymap";
import { createKeymapHandler } from "@/lib/keymap";

export interface KeymapOptions {
	/**
	 * Listen in the window's capture phase, before any element (or Radix's
	 * document-level layer stack) sees the key: for bindings whose turn
	 * must not depend on which layer is on top, like Escape closing the
	 * details panel while a tooltip shows.
	 */
	capture?: boolean;
}

export const useKeymap = (
	bindings: KeyBinding[],
	{ capture = false }: KeymapOptions = {},
) => {
	const bindingsRef = useRef(bindings);
	bindingsRef.current = bindings;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			dispatchKeymapEvent(bindingsRef.current, event);
		};
		window.addEventListener("keydown", onKeyDown, capture);
		return () => window.removeEventListener("keydown", onKeyDown, capture);
	}, [capture]);
};

export const dispatchKeymapEvent = (
	bindings: KeyBinding[],
	event: KeyboardEvent,
) => {
	// One key press, one action: a key another keymap (or a layer
	// such as a tooltip) already acted on is left alone, even when
	// that action re-rendered this keymap in time to match it again.
	if (event.defaultPrevented && !browserGuardedEvents.has(event)) return;
	const handler = createKeymapHandler(bindings);
	const handled = handler({
		key: event.key,
		code: event.code,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		shiftKey: event.shiftKey,
		altKey: event.altKey,
		target: event.target as EditableTargetLike | null,
		preventDefault: () => event.preventDefault(),
	});
	if (handled) browserGuardedEvents.delete(event);
};
