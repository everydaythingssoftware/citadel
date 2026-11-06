import { type RefObject, useEffect, useState } from "react";

/**
 * Whether the element with `targetId` has scrolled up under the bar that
 * `barRef` sits in (its nearest <header>), e.g. a form's Title field passing
 * under a pinned header. False until it does; re-arms when `key` changes.
 */
export const useScrolledUnder = (
	targetId: string,
	barRef: RefObject<HTMLElement | null>,
	key: unknown,
): boolean => {
	const [under, setUnder] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key re-arms the observer for a new page
	useEffect(() => {
		const target = document.getElementById(targetId);
		const bar = barRef.current?.closest("header") ?? barRef.current;
		if (!target || !bar || typeof IntersectionObserver === "undefined") return;
		setUnder(false);
		// Everything above the bar's bottom edge counts as out of view.
		const top = Math.max(0, Math.round(bar.getBoundingClientRect().bottom));
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				setUnder(
					!entry.isIntersecting && entry.boundingClientRect.bottom <= top,
				);
			},
			{ rootMargin: `-${top}px 0px 0px 0px` },
		);
		observer.observe(target);
		return () => observer.disconnect();
	}, [targetId, barRef, key]);
	return under;
};
