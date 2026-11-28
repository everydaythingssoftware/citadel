import { type RefObject, useEffect, useState } from "react";

export interface ScrollEdges {
	/** Content is hidden above: scrolled away from the top. */
	above: boolean;
	/** Content is hidden below. */
	below: boolean;
}

/** Which ends of a scroll container have content scrolled out of view. */
export const useScrollEdges = (
	container: RefObject<HTMLElement | null>,
): ScrollEdges => {
	const [edges, setEdges] = useState<ScrollEdges>({
		above: false,
		below: false,
	});
	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const update = () => {
			const above = element.scrollTop > 0;
			const below =
				element.scrollTop + element.clientHeight < element.scrollHeight - 1;
			setEdges((before) =>
				before.above === above && before.below === below
					? before
					: { above, below },
			);
		};
		update();
		element.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(element);
		for (const child of element.children) observer.observe(child);
		return () => {
			element.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [container]);
	return edges;
};
