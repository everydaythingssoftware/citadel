import { type RefObject, useLayoutEffect } from "react";

const verticalPadding = (element: HTMLElement): number => {
	const style = getComputedStyle(element);
	return (
		Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
	);
};

/**
 * Gives a sheet an explicit height, so CSS can animate it: as tall as its
 * content (header, the natural height of the scroller's content, footer) up
 * to its max-height, or a fixed height while `fixed` is set. CSS can't
 * transition to or from `auto` in WebKit, hence the measuring. Sheets that
 * fill the screen (phones, `fill` matches) are left alone.
 */
export const useSheetHeight = ({
	sheet,
	scroller,
	content,
	fixed,
	fill = "(max-width: 36em)",
}: {
	sheet: RefObject<HTMLElement | null>;
	/** The scrolling middle, whose padding counts. */
	scroller: RefObject<HTMLElement | null>;
	/** What the scroller holds, unstretched. */
	content: RefObject<HTMLElement | null>;
	/** A height to hold instead, e.g. the review's. */
	fixed?: number;
	fill?: string;
}) => {
	useLayoutEffect(() => {
		const element = sheet.current;
		if (!element) return;
		const fills = window.matchMedia(fill);
		const fitHeight = () => {
			if (fills.matches) {
				element.style.height = "";
				return;
			}
			if (fixed !== undefined) {
				element.style.height = `${fixed}px`;
				return;
			}
			const middle = scroller.current;
			const inner = content.current;
			if (!middle || !inner) {
				element.style.height = "";
				return;
			}
			const chrome = [...element.children].reduce(
				(sum, child) =>
					child === middle || !(child instanceof HTMLElement)
						? sum
						: sum + child.offsetHeight,
				0,
			);
			const borders = element.offsetHeight - element.clientHeight;
			element.style.height = `${
				chrome + inner.offsetHeight + verticalPadding(middle) + borders
			}px`;
		};
		fitHeight();
		const observer = new ResizeObserver(fitHeight);
		if (content.current) observer.observe(content.current);
		for (const child of element.children) observer.observe(child);
		fills.addEventListener("change", fitHeight);
		return () => {
			observer.disconnect();
			fills.removeEventListener("change", fitHeight);
		};
	}, [sheet, scroller, content, fixed, fill]);
};
