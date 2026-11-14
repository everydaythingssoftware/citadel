import { useLayoutEffect, useState } from "react";
import {
	type EdgeResize,
	ResizeEdge,
	useEdgeResize,
} from "@/lib/hooks/use-edge-resize";
import {
	BOOK_DRAWER_WIDTH,
	bookDrawerMaxWidth,
	useBookDrawer,
} from "@/stores/book-drawer/store";

const useParentWidth = (child: HTMLElement | null): number | null => {
	const [width, setWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		const element = child?.parentElement;
		if (!element) return;
		setWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, [child]);
	return width;
};

/**
 * The book drawer's left edge. The width shown never exceeds 70% of the
 * panel the drawer (`drawer`, while mounted) sits in; a drag past that
 * stops there, so the stored width is always one the user saw.
 */
export const useBookDrawerResize = (drawer: HTMLElement | null): EdgeResize => {
	const stored = useBookDrawer((s) => s.width);
	const setStored = useBookDrawer((s) => s.setWidth);
	const resetWidth = useBookDrawer((s) => s.resetWidth);
	const max = bookDrawerMaxWidth(useParentWidth(drawer));
	return useEdgeResize({
		width: Math.min(stored, max),
		min: BOOK_DRAWER_WIDTH.min,
		max,
		step: BOOK_DRAWER_WIDTH.step,
		edge: ResizeEdge.left,
		label: "Resize Details",
		setWidth: (width) => setStored(Math.min(width, max)),
		resetWidth,
	});
};
