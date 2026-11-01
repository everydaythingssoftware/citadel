import { useEffect, useRef, useState } from "react";

const carriesFiles = (event: DragEvent): boolean =>
	event.dataTransfer?.types.includes("Files") ?? false;

/**
 * Tracks files dragged anywhere over the window and hands them over when
 * dropped. Nested elements fire their own enter/leave pairs, so a depth
 * counter keeps the drag "in" until the pointer really leaves the window.
 */
export const useFileDrag = ({
	enabled,
	onDrop,
}: {
	enabled: boolean;
	onDrop: (files: File[]) => void;
}): boolean => {
	const [dragging, setDragging] = useState(false);
	const onDropRef = useRef(onDrop);
	onDropRef.current = onDrop;

	useEffect(() => {
		if (!enabled) {
			setDragging(false);
			return;
		}
		let depth = 0;
		const reset = () => {
			depth = 0;
			setDragging(false);
		};
		const onEnter = (event: DragEvent) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			depth += 1;
			setDragging(true);
		};
		const onOver = (event: DragEvent) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		};
		const onLeave = (event: DragEvent) => {
			if (!carriesFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const onDropEvent = (event: DragEvent) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			reset();
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length > 0) onDropRef.current(files);
		};
		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragover", onOver);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("drop", onDropEvent);
		window.addEventListener("dragend", reset);
		window.addEventListener("blur", reset);
		return () => {
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("drop", onDropEvent);
			window.removeEventListener("dragend", reset);
			window.removeEventListener("blur", reset);
		};
	}, [enabled]);

	return dragging;
};
