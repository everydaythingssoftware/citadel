import { type RefObject, useEffect, useState } from "react";

/** Whether a scroll container has moved away from its top. */
export const useScrolled = (
	container: RefObject<HTMLElement | null>,
): boolean => {
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const update = () => setScrolled(element.scrollTop > 0);
		update();
		element.addEventListener("scroll", update, { passive: true });
		return () => element.removeEventListener("scroll", update);
	}, [container]);
	return scrolled;
};
