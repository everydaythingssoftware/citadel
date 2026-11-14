import { useEffect, useRef, useState } from "react";
import { menuRoom, unclippedMenuHeight } from "@/lib/select-menu-fit";

const px = (value: string) => Number.parseFloat(value) || 0;

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Shows a short pop-up menu whole once Radix has placed it. */
const fitMenu = (viewport: HTMLElement) => {
	const content = viewport.parentElement;
	const wrapper = content?.parentElement;
	if (!content || !wrapper) return;
	const style = window.getComputedStyle(content);
	const fullHeight =
		px(style.borderTopWidth) +
		px(style.paddingTop) +
		viewport.scrollHeight +
		px(style.paddingBottom) +
		px(style.borderBottomWidth);
	const rect = wrapper.getBoundingClientRect();
	const height = unclippedMenuHeight({
		room: menuRoom({
			top: rect.top,
			bottom: rect.bottom,
			viewportHeight: window.innerHeight,
			pinnedToBottom: wrapper.style.bottom === "0px",
		}),
		height: content.getBoundingClientRect().height,
		fullHeight,
		scrollTop: viewport.scrollTop,
	});
	if (height === null) return;
	// Unscroll first: Radix grows the menu by what it scrolls back, and the
	// scroll event brings us back here for whatever height is still missing.
	if (viewport.scrollTop > 0) viewport.scrollTop = 0;
	else wrapper.style.height = `${height}px`;
};

/**
 * Open state and a viewport ref for `Select`: once the menu is placed, a
 * short list that Radix shortened near the top of the window shows whole
 * (see `unclippedMenuHeight`).
 */
export const useSelectMenuFit = () => {
	const [open, setOpen] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		let viewport: HTMLDivElement | null = null;
		// A list that fits has nothing to scroll to, so any scroll it gets
		// (Radix's placement, its scroll arrow bringing the chosen item into
		// view as it mounts) is undone as it happens.
		const refit = () => {
			if (viewport) fitMenu(viewport);
		};
		void (async () => {
			await nextFrame();
			if (cancelled) return;
			viewport = viewportRef.current;
			viewport?.addEventListener("scroll", refit);
			refit();
			await nextFrame();
			if (!cancelled) refit();
		})();
		return () => {
			cancelled = true;
			viewport?.removeEventListener("scroll", refit);
		};
	}, [open]);

	return { open, onOpenChange: setOpen, viewportRef };
};
