import { useEffect, useState } from "react";
import {
	continuesHintHold,
	endsHintHold,
	type HintModifier,
	type ModifierKeyEvent,
	startsHintHold,
} from "@/lib/sidebar-navigation";

const asModifierEvent = (event: KeyboardEvent): ModifierKeyEvent => ({
	key: event.key,
	code: event.code,
	repeat: event.repeat,
	ctrlKey: event.ctrlKey,
	metaKey: event.metaKey,
	altKey: event.altKey,
	shiftKey: event.shiftKey,
	target: event.target as ModifierKeyEvent["target"],
});

/**
 * Whether the sidebar shows its shortcut digits: as soon as `modifier`
 * (Ctrl, ⌘ on the Mac) goes down alone, outside a field and with no
 * pointer button down. They stay up across the chords that walk the
 * sidebar (Ctrl+Page Up/Down, Ctrl+Tab, ⌘/Ctrl+digit); any other key (a
 * chord such as Ctrl+C), the modifier's release, a press of the pointer,
 * or the window losing focus hides them.
 */
export const useShortcutHints = (
	modifier: HintModifier,
	enabled: boolean,
): boolean => {
	const [shown, setShown] = useState(false);

	useEffect(() => {
		if (!enabled) return;
		let pointerDown = false;
		const hide = () => setShown(false);
		const onKeyDown = (event: KeyboardEvent) => {
			const press = asModifierEvent(event);
			if (continuesHintHold(press, modifier)) return;
			hide();
			if (pointerDown || !startsHintHold(press, modifier)) return;
			setShown(true);
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (endsHintHold(event, modifier)) hide();
		};
		const onPointerDown = () => {
			pointerDown = true;
			hide();
		};
		const onPointerUp = () => {
			pointerDown = false;
		};
		const onVisibility = () => {
			if (document.hidden) hide();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", hide);
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("pointerup", onPointerUp, true);
		window.addEventListener("pointercancel", onPointerUp, true);
		window.addEventListener("dragstart", onPointerDown, true);
		window.addEventListener("dragend", onPointerUp, true);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			hide();
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", hide);
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("pointerup", onPointerUp, true);
			window.removeEventListener("pointercancel", onPointerUp, true);
			window.removeEventListener("dragstart", onPointerDown, true);
			window.removeEventListener("dragend", onPointerUp, true);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [modifier, enabled]);

	return enabled && shown;
};
