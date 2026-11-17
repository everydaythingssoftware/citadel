import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
	BOOK_GRID,
	type BookGridLayout,
	bookGridLayout,
	openSidebarPanelWidth,
	sameBookGridLayout,
} from "@/lib/grid-virtual";

/**
 * Marks the shell's sidebar (`__root.tsx`). Its first child is the
 * full-width inner column, as wide as the open sidebar even while the
 * sidebar is closed or sliding.
 */
export const SHELL_SIDEBAR_ATTRIBUTE = "data-shell-sidebar";

/**
 * Until the panel is measured: three full-size columns, the tallest the
 * shelf gets, so an offset restored on Back fits in the first frame.
 */
const UNMEASURED_LAYOUT = bookGridLayout(
	BOOK_GRID.minColumns * BOOK_GRID.cellWidth +
		(BOOK_GRID.minColumns - 1) * BOOK_GRID.columnGap +
		BOOK_GRID.padding.x * 2,
);

const widthOf = (element: Element | null | undefined): number =>
	element ? element.getBoundingClientRect().width : 0;

/** The phone layout's sidebar is fixed over the panel and takes none of it. */
const inFlow = (element: Element | null): element is Element =>
	element !== null && getComputedStyle(element).position !== "fixed";

interface BookGridLayoutOptions {
	/** The grid's full-width wrapper inside the scroll region. */
	wrapperRef: RefObject<HTMLElement | null>;
	/** Runs just before the layout changes, while the old rows are on screen. */
	onWillRelayout?: () => void;
}

/**
 * The cover grid's layout, from the width the panel would have with the
 * sidebar open (the panel alone where the sidebar overlays it). That width
 * holds still while the sidebar slides, so a toggle only slides the centred
 * block; a window resize or a drag of the sidebar's edge changes it, and the
 * new columns are committed before the frame paints.
 */
export const useBookGridLayout = ({
	wrapperRef,
	onWillRelayout,
}: BookGridLayoutOptions): BookGridLayout => {
	const [layout, setLayout] = useState(UNMEASURED_LAYOUT);
	const willRelayoutRef = useRef(onWillRelayout);
	willRelayoutRef.current = onWillRelayout;

	useLayoutEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;
		const sidebar = document.querySelector(`[${SHELL_SIDEBAR_ATTRIBUTE}]`);
		const sidebarInner = sidebar?.firstElementChild;
		let current: BookGridLayout | null = null;
		const update = () => {
			const beside = inFlow(sidebar);
			const next = bookGridLayout(
				openSidebarPanelWidth({
					panelWidth: widthOf(wrapper),
					sidebarWidth: beside ? widthOf(sidebar) : 0,
					openSidebarWidth: beside ? widthOf(sidebarInner) : 0,
				}),
			);
			if (current === null) {
				current = next;
				setLayout(next);
				return;
			}
			if (sameBookGridLayout(current, next)) return;
			willRelayoutRef.current?.();
			current = next;
			flushSync(() => setLayout(next));
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(wrapper);
		if (sidebarInner) observer.observe(sidebarInner);
		return () => observer.disconnect();
	}, [wrapperRef]);

	return layout;
};
