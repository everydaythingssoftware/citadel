import { type RefObject, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Scroll quiet for this long counts as the end of a programmatic scroll. */
const SETTLE_MS = 120;

/** Sideways wheel travel (trackpad pixels) that moves to the next book. */
const PAGE_TRAVEL = 36;
/** Wheel quiet for this long ends a trackpad gesture and its momentum. */
const GESTURE_END_MS = 140;
/** How far the row can be pulled past either end, at most. */
const STRETCH_LIMIT = 56;

/** Rubber-band resistance: the further you pull, the less it gives. */
export const stretchFor = (travel: number): number => {
	const pull = Math.abs(travel);
	const give = STRETCH_LIMIT * (1 - 1 / (pull / (STRETCH_LIMIT * 1.6) + 1));
	return Math.sign(travel) * give;
};

const slideAt = (element: HTMLElement, target: number) =>
	element.querySelector<HTMLElement>(`[data-slide-index="${target}"]`);

/** The slide whose middle is closest to the track's centre. */
const nearestSlide = (element: HTMLElement): number | undefined => {
	const centre = element.scrollLeft + element.clientWidth / 2;
	let nearest: number | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const slide of element.querySelectorAll<HTMLElement>(
		"[data-slide-index]",
	)) {
		const middle = slide.offsetLeft + slide.offsetWidth / 2;
		if (Math.abs(middle - centre) < distance) {
			distance = Math.abs(middle - centre);
			nearest = Number(slide.dataset.slideIndex);
		}
	}
	return nearest;
};

/**
 * Keeps a horizontally scrolling, snapping track and a selected index in step:
 * when the index changes the track scrolls its slide to the centre, and while
 * the person swipes, the selection follows whichever slide is nearest the
 * centre, changing as soon as the swipe passes halfway. Slides are the
 * track's children marked `data-slide-index`.
 */
export const useCarouselScroll = ({
	track,
	index,
	onSelect,
	paused = false,
}: {
	track: RefObject<HTMLElement | null>;
	index: number;
	onSelect: (index: number) => void;
	/** Holds both directions while slides animate in or out. */
	paused?: boolean;
}) => {
	const reduced = usePrefersReducedMotion();
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	// While the track scrolls itself to a chosen slide, slides it passes on
	// the way mustn't become the selection.
	const programmatic = useRef(false);
	// The index the person's own swiping chose; the track is already there.
	const swiped = useRef<number | undefined>(undefined);
	const first = useRef(true);
	const indexRef = useRef(index);
	indexRef.current = index;

	useEffect(() => {
		const element = track.current;
		if (!element || paused) return;
		if (swiped.current === index) return;
		swiped.current = undefined;
		const slide = slideAt(element, index);
		if (!slide) return;
		const left =
			slide.offsetLeft - (element.clientWidth - slide.offsetWidth) / 2;
		if (Math.abs(element.scrollLeft - left) < 2) return;
		programmatic.current = true;
		element.scrollTo({
			left,
			behavior: first.current || reduced ? "instant" : "smooth",
		});
		first.current = false;
	}, [track, index, paused, reduced]);

	// Trackpads and mouse wheels page instead of scrolling: snapping across a
	// whole cover's width took a long, hard swipe. One gesture (with its
	// momentum) moves one book; past either end the row stretches and springs
	// back. Vertical wheeling is left to scroll the page. Touch never sends
	// wheel events, so swiping on phones is untouched.
	useEffect(() => {
		const element = track.current;
		if (!element || paused) return;
		let travel = 0;
		let paged = false;
		let lastPull = 0;
		let pagedAt = 0;
		let quiet: ReturnType<typeof setTimeout> | undefined;
		const stretch = (amount: number) => {
			element.style.transition = "none";
			element.style.transform =
				amount === 0 ? "" : `translateX(${-stretchFor(amount)}px)`;
		};
		const springBack = () => {
			if (!element.style.transform) return;
			element.style.transition = reduced
				? "none"
				: "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
			element.style.transform = "";
		};
		const endGesture = () => {
			travel = 0;
			paged = false;
			lastPull = 0;
			springBack();
		};
		const onWheel = (event: WheelEvent) => {
			if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
			event.preventDefault();
			clearTimeout(quiet);
			quiet = setTimeout(endGesture, GESTURE_END_MS);
			const pull = Math.abs(event.deltaX);
			// Momentum only ever fades; a pull growing again after a page is
			// a fresh swipe, so it can page again.
			if (
				paged &&
				pull > lastPull * 1.5 &&
				pull > 4 &&
				performance.now() - pagedAt > 180
			) {
				paged = false;
				travel = 0;
			}
			lastPull = pull;
			if (paged) return;
			travel += event.deltaX;
			const target = indexRef.current + Math.sign(travel);
			if (!slideAt(element, target)) {
				if (!reduced) stretch(travel);
				return;
			}
			if (Math.abs(travel) < PAGE_TRAVEL) return;
			paged = true;
			pagedAt = performance.now();
			travel = 0;
			onSelectRef.current(target);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			clearTimeout(quiet);
			element.removeEventListener("wheel", onWheel);
			element.style.transform = "";
			element.style.transition = "";
		};
	}, [track, paused, reduced]);

	useEffect(() => {
		const element = track.current;
		if (!element || paused) return;
		let settle: ReturnType<typeof setTimeout> | undefined;
		const onScroll = () => {
			clearTimeout(settle);
			settle = setTimeout(() => {
				programmatic.current = false;
			}, SETTLE_MS);
			if (programmatic.current) return;
			const nearest = nearestSlide(element);
			if (nearest === undefined || nearest === index) return;
			swiped.current = nearest;
			onSelectRef.current(nearest);
		};
		// A touch means the person has taken over from any glide.
		const takeOver = () => {
			programmatic.current = false;
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		element.addEventListener("pointerdown", takeOver, { passive: true });
		element.addEventListener("touchstart", takeOver, { passive: true });
		return () => {
			clearTimeout(settle);
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("pointerdown", takeOver);
			element.removeEventListener("touchstart", takeOver);
		};
	}, [track, index, paused]);
};
