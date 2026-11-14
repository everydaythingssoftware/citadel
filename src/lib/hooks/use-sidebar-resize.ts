import {
	type EdgeResize,
	ResizeEdge,
	useEdgeResize,
} from "@/lib/hooks/use-edge-resize";
import { SIDEBAR_WIDTH, useSidebar } from "@/stores/sidebar/store";

export type SidebarResize = EdgeResize;

/** The sidebar's right edge (see useEdgeResize). */
export const useSidebarResize = (): SidebarResize =>
	useEdgeResize({
		width: useSidebar((s) => s.width),
		min: SIDEBAR_WIDTH.min,
		max: SIDEBAR_WIDTH.max,
		step: SIDEBAR_WIDTH.step,
		edge: ResizeEdge.right,
		label: "Resize Sidebar",
		setWidth: useSidebar((s) => s.setWidth),
		resetWidth: useSidebar((s) => s.resetWidth),
	});
