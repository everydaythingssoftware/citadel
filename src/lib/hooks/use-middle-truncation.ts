import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { fitMiddleTruncated } from "@/lib/middle-truncate";

let canvas: HTMLCanvasElement | null = null;

const measurer = (element: HTMLElement) => {
	canvas ??= document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (!context) return null;
	const style = getComputedStyle(element);
	context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const spacing = Number.parseFloat(style.letterSpacing) || 0;
	return (text: string) =>
		context.measureText(text).width + spacing * Array.from(text).length;
};

/**
 * Shortens `text` in the middle to fit its element's width, re-fitting as
 * the element resizes. Until measured, CSS ellipsis covers the end.
 */
export const useMiddleTruncation = <TElement extends HTMLElement>(
	text: string,
): [RefObject<TElement | null>, string] => {
	const ref = useRef<TElement>(null);
	const [shown, setShown] = useState(text);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const refit = () => {
			const width = element.clientWidth;
			const measure = measurer(element);
			if (width === 0 || !measure) {
				setShown(text);
				return;
			}
			setShown(
				fitMiddleTruncated(text, (candidate) => measure(candidate) <= width),
			);
		};
		refit();
		const observer = new ResizeObserver(refit);
		observer.observe(element);
		void document.fonts?.ready.then(refit);
		return () => observer.disconnect();
	}, [text]);

	return [ref, shown];
};
