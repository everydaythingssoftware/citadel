import { type RefObject, useLayoutEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * Scrolls a list's container to the end whenever items are appended, or
 * when `reveal` turns on, so what was just added (or the drop area at the
 * end) is in view even if the person had scrolled up.
 */
export const useFollowNewest = (
	container: RefObject<HTMLElement | null>,
	count: number,
	reveal = false,
) => {
	const reduced = usePrefersReducedMotion();
	const previous = useRef({ count, reveal });
	useLayoutEffect(() => {
		const grew = count > previous.current.count;
		const revealed = reveal && !previous.current.reveal;
		previous.current = { count, reveal };
		const element = container.current;
		if (!element || !(grew || revealed)) return;
		element.scrollTo({
			top: element.scrollHeight,
			behavior: reduced ? "instant" : "smooth",
		});
	}, [container, count, reveal, reduced]);
};
