import { type RefObject, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** How long scrolling must pause before the nearest slide counts as chosen. */
const SETTLE_MS = 90;

const slideAt = (element: HTMLElement, target: number) =>
	element.querySelector<HTMLElement>(`[data-slide-index="${target}"]`);

/**
 * Keeps a horizontally scrolling, snapping track and a selected index in step:
 * when the index changes the track scrolls its slide to the centre, and when
 * the person swipes the track the slide that settles in the centre becomes
 * the selection. Slides are the track's children marked `data-slide-index`.
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
	const programmatic = useRef(false);
	const first = useRef(true);

	useEffect(() => {
		const element = track.current;
		if (!element || paused) return;
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
				const wasProgrammatic = programmatic.current;
				programmatic.current = false;
				if (wasProgrammatic) return;
				const centre = element.scrollLeft + element.clientWidth / 2;
				let nearest = index;
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
				if (nearest !== index) onSelectRef.current(nearest);
			}, SETTLE_MS);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			clearTimeout(settle);
			element.removeEventListener("scroll", onScroll);
		};
	}, [track, index, paused]);
};
