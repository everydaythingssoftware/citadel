import { useLayoutEffect, useState } from "react";
import {
	type EdgeResize,
	ResizeEdge,
	useEdgeResize,
} from "@/lib/hooks/use-edge-resize";
import {
	SIDEBAR_WIDTH,
	sidebarMaxWidth,
	useSidebar,
} from "@/stores/sidebar/store";

const useWindowWidth = (): number | null => {
	const [width, setWidth] = useState<number | null>(() =>
		typeof window === "undefined" ? null : window.innerWidth,
	);
	useLayoutEffect(() => {
		const update = () => setWidth(window.innerWidth);
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return width;
};

export type SidebarResize = EdgeResize;

/**
 * The sidebar's right edge (see useEdgeResize). The width shown never
 * exceeds a third of the window; a drag past that stops there, so the
 * stored width is always one the user saw.
 */
export const useSidebarResize = (): SidebarResize => {
	const stored = useSidebar((s) => s.width);
	const setStored = useSidebar((s) => s.setWidth);
	const resetWidth = useSidebar((s) => s.resetWidth);
	const max = sidebarMaxWidth(useWindowWidth());
	return useEdgeResize({
		width: Math.min(stored, max),
		min: SIDEBAR_WIDTH.min,
		max,
		step: SIDEBAR_WIDTH.step,
		edge: ResizeEdge.right,
		label: "Resize sidebar",
		setWidth: (width) => setStored(Math.min(width, max)),
		resetWidth,
	});
};
