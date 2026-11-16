import type { OperatingSystem } from "@/lib/platform/os";

/** How long a scrollbar stays after the last scroll, like macOS's fade. */
export const SCROLLBAR_LINGER_MS = 900;

/**
 * macOS draws its own overlay scrollbars and honours "Show scroll bars";
 * phones and tablets float theirs too. Only the rest need ours.
 */
export const needsOverlayScrollbars = (os: OperatingSystem): boolean =>
	os === "windows" || os === "linux" || os === "other";

/**
 * Marks whatever is scrolling with data-scrolling until it rests, so CSS can
 * show the thumb only then (see styles.css).
 */
export const installScrollActivity = (
	doc: Document = document,
	lingerMs: number = SCROLLBAR_LINGER_MS,
): (() => void) => {
	const timers = new Map<Element, ReturnType<typeof setTimeout>>();
	const onScroll = (event: Event) => {
		const target =
			event.target !== null && "setAttribute" in event.target
				? (event.target as Element)
				: doc.documentElement;
		const pending = timers.get(target);
		if (pending) clearTimeout(pending);
		else target.setAttribute("data-scrolling", "");
		timers.set(
			target,
			setTimeout(() => {
				timers.delete(target);
				target.removeAttribute("data-scrolling");
			}, lingerMs),
		);
	};
	doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
	return () => {
		doc.removeEventListener("scroll", onScroll, { capture: true });
		for (const [target, timer] of timers) {
			clearTimeout(timer);
			target.removeAttribute("data-scrolling");
		}
		timers.clear();
	};
};
