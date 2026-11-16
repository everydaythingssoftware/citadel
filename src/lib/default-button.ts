export interface DefaultButtonKeyEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	nativeEvent?: { isComposing?: boolean };
	target: unknown;
}

const isMultilineText = (target: unknown): boolean => {
	if (typeof target !== "object" || target === null) return false;
	const element = target as { tagName?: string; isContentEditable?: boolean };
	return element.tagName === "TEXTAREA" || element.isContentEditable === true;
};

/**
 * Return presses an alert's default button wherever focus is, as on macOS
 * (Space still presses the focused one). Not while an IME is composing, and
 * not in multi-line text, where Return is a new line.
 */
export const isDefaultButtonKey = (event: DefaultButtonKeyEvent): boolean =>
	event.key === "Enter" &&
	!event.metaKey &&
	!event.ctrlKey &&
	!event.altKey &&
	!event.shiftKey &&
	!event.nativeEvent?.isComposing &&
	!isMultilineText(event.target);
