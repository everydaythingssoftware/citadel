import { useLayoutEffect, useState } from "react";
import {
	type EdgeResize,
	ResizeEdge,
	useEdgeResize,
} from "@/lib/hooks/use-edge-resize";
import { none, type Option, some } from "@/lib/option";
import { useBookDrawerWidth } from "@/stores/book-drawer/store";

const useParentWidth = (child: HTMLElement | null): Option<number> => {
	const [width, setWidth] = useState<Option<number>>(none());
	useLayoutEffect(() => {
		const element = child?.parentElement;
		if (!element) return;
		setWidth(some(element.clientWidth));
		const observer = new ResizeObserver(() =>
			setWidth(some(element.clientWidth)),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [child]);
	return width;
};

/** The book drawer's left edge, within the panel `drawer` (while mounted) sits in. */
export const useBookDrawerResize = (drawer: HTMLElement | null): EdgeResize =>
	useEdgeResize(useBookDrawerWidth, {
		edge: ResizeEdge.left,
		label: "Resize details",
		containerWidth: useParentWidth(drawer),
	});
