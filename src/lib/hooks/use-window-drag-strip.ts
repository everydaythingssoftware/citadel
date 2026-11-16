import { useEffect, useRef } from "react";
import { passesWindowDragThrough } from "@/lib/window-drag";

/**
 * Keeps the window-drag strip out of the way of controls: while the pointer
 * is over a button, link or field beneath it, the strip lets events through;
 * over anything else (a scrim, a curtain, a title) it catches the press, and
 * Tauri's drag script moves the window.
 */
export const useWindowDragStrip = () => {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onPointerMove = (event: PointerEvent) => {
			const strip = ref.current;
			if (!strip) return;
			if (event.clientY > strip.offsetHeight) {
				delete strip.dataset.passThrough;
				return;
			}
			const under = document
				.elementsFromPoint(event.clientX, event.clientY)
				.find((element) => element !== strip);
			if (passesWindowDragThrough(under)) strip.dataset.passThrough = "";
			else delete strip.dataset.passThrough;
		};
		document.addEventListener("pointermove", onPointerMove, {
			capture: true,
			passive: true,
		});
		return () =>
			document.removeEventListener("pointermove", onPointerMove, {
				capture: true,
			});
	}, []);

	// Radix closes menus and popovers on a press outside them; a press that
	// moves the window isn't one.
	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		event.stopPropagation();
	};

	return { ref, onPointerDown };
};
