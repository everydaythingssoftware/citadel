import type { LibrarySeries } from "@/bindings";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState } from "react";

const findScrollParent = (element: HTMLElement): HTMLElement | null => {
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (["auto", "scroll"].includes(getComputedStyle(node).overflowY)) {
			return node;
		}
	}
	return null;
};

export const useSeriesRows = (series: LibrarySeries[]) => {
	const rowsRef = useRef<HTMLDivElement>(null);
	const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
	const [scrollMargin, setScrollMargin] = useState(0);

	useLayoutEffect(() => {
		const rows = rowsRef.current;
		if (!rows) return;
		const parent = findScrollParent(rows);
		setScrollElement(parent);
		if (!parent) return;

		const measure = () => {
			setScrollMargin(
				rows.getBoundingClientRect().top -
					parent.getBoundingClientRect().top +
					parent.scrollTop,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	const virtualizer = useVirtualizer({
		count: series.length,
		getScrollElement: () => scrollElement,
		getItemKey: (index) => series[index]?.id ?? index,
		estimateSize: () => 40,
		overscan: 10,
		scrollMargin,
	});

	const previousSeries = useRef(series);
	useLayoutEffect(() => {
		if (previousSeries.current !== series) {
			if (scrollElement) scrollElement.scrollTop = 0;
			previousSeries.current = series;
		}
	}, [series, scrollElement]);

	return { rowsRef, virtualizer, scrollMargin };
};
