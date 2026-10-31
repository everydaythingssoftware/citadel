import { type RefObject, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Scroll quiet for this long counts as the end of a programmatic scroll. */
const SETTLE_MS = 120;

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
