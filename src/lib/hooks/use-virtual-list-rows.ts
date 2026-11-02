import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState } from "react";

const ROW_HEIGHT = 40;
const OVERSCAN_ROWS = 10;

const findScrollParent = (element: HTMLElement): HTMLElement | null => {
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (["auto", "scroll"].includes(getComputedStyle(node).overflowY)) {
			return node;
		}
	}
	return null;
};

/**
 * Virtualizes a page-level list of id-keyed rows (authors, series, tags,
 * publishers) inside the nearest scrolling ancestor, so the page's sticky
 * header and footer keep pinning to that same region.
 *
 * Scrolls back to the top when `resetKey` changes. It defaults to the list
 * itself (e.g. a new search term); pass a narrower key when the list also
 * changes for edits that should keep the reader's place.
 */
export const useVirtualListRows = <T extends { id: number | string }>(
	items: T[],
	resetKey: unknown = items,
) => {
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
		count: items.length,
		getScrollElement: () => scrollElement,
		getItemKey: (index) => items[index]?.id ?? index,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN_ROWS,
		scrollMargin,
	});

	const previousResetKey = useRef(resetKey);
	useLayoutEffect(() => {
		if (!Object.is(previousResetKey.current, resetKey)) {
			if (scrollElement) scrollElement.scrollTop = 0;
			previousResetKey.current = resetKey;
		}
	}, [resetKey, scrollElement]);

	return { rowsRef, virtualizer, scrollMargin };
};
