import { type RefObject, useLayoutEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * Scrolls a list's container to the end whenever items are appended, so
 * what was just added is in view even if the person had scrolled up.
 */
export const useFollowNewest = (
	container: RefObject<HTMLElement | null>,
	count: number,
) => {
	const reduced = usePrefersReducedMotion();
	const previous = useRef(count);
	useLayoutEffect(() => {
		const grew = count > previous.current;
		previous.current = count;
		const element = container.current;
		if (!grew || !element) return;
		element.scrollTo({
			top: element.scrollHeight,
			behavior: reduced ? "instant" : "smooth",
		});
	}, [container, count, reduced]);
};
