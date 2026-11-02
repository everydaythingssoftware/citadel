import { useEffect, useState } from "react";

/** Below this visible height, a completion list can't fit beside a field and the keyboard. */
const CRAMPED_HEIGHT = 560;
/** The visual viewport shrinking by more than this means an on-screen keyboard. */
const KEYBOARD_MIN = 100;
/** Taller screens than this (tablets) have room for a list beside the keyboard. */
const PHONE_SCREEN_MAX = 1000;
/** Fields that bring up the on-screen keyboard (or a picker in its place). */
const TYPED_FIELD =
	'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"]), textarea, [contenteditable=""], [contenteditable="true"]';

export interface VisibleViewport {
	/** The visible area's top, in the coordinates `position: fixed` uses. */
	top: number;
	height: number;
	/** A touch screen: lists attach to their fields. */
	touch: boolean;
	/** An on-screen keyboard is covering part of the page. */
	keyboard: boolean;
	/** The keyboard leaves little room: fields go just above it, lists above them. */
	cramped: boolean;
}

const measure = (): VisibleViewport => {
	const viewport =
		typeof window === "undefined" ? undefined : window.visualViewport;
	if (!viewport)
		return {
			top: 0,
			height: typeof window === "undefined" ? 0 : window.innerHeight,
			touch: false,
			keyboard: false,
			cramped: false,
		};
	const touch = matchMedia("(pointer: coarse)").matches;
	// iOS doesn't always shrink the visual viewport against innerHeight, so
	// a focused text field on a touch screen counts as the keyboard being up.
	const typing = document.activeElement?.matches(TYPED_FIELD) === true;
	const keyboard =
		touch && (typing || window.innerHeight - viewport.height > KEYBOARD_MIN);
	return {
		top: viewport.offsetTop,
		height: viewport.height,
		touch,
		keyboard,
		cramped:
			keyboard &&
			(viewport.height < CRAMPED_HEIGHT ||
				window.screen.height < PHONE_SCREEN_MAX),
	};
};

const same = (a: VisibleViewport, b: VisibleViewport) =>
	a.top === b.top &&
	a.height === b.height &&
	a.touch === b.touch &&
	a.keyboard === b.keyboard &&
	a.cramped === b.cramped;

/**
 * The part of the page actually on screen. On iOS the keyboard shrinks only
 * the visual viewport, and the browser pans it to keep a focused field in
 * view, so fixed full-screen layers must follow it to stay visible.
 */
export const useVisibleViewport = (): VisibleViewport => {
	const [viewport, setViewport] = useState(measure);
	useEffect(() => {
		const visual = window.visualViewport;
		const update = () =>
			setViewport((before) => {
				const next = measure();
				return same(before, next) ? before : next;
			});
		update();
		// Moving from field to field blurs one before focusing the next; wait
		// a moment so that doesn't read as the keyboard going away.
		let blur: ReturnType<typeof setTimeout> | undefined;
		const onFocusOut = () => {
			clearTimeout(blur);
			blur = setTimeout(update, 60);
		};
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", onFocusOut);
		visual?.addEventListener("resize", update);
		visual?.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		return () => {
			clearTimeout(blur);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", onFocusOut);
			visual?.removeEventListener("resize", update);
			visual?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, []);
	return viewport;
};
