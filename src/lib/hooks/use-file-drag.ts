import { useEffect, useRef, useState } from "react";
import { dragOutGuard } from "@/lib/drag-out-guard";
import { usePlatform } from "@/lib/platform/context";
import type { BookSource } from "@/lib/uploads/queue";

const carriesFiles = (event: DragEvent): boolean =>
	event.dataTransfer?.types.includes("Files") ?? false;

/**
 * Tracks files dragged anywhere over the window and hands them over when
 * dropped. The desktop reports drags natively, by path; in a browser nested
 * elements fire their own enter/leave pairs, so a depth counter keeps the
 * drag "in" until the pointer really leaves the window.
 */
export const useFileDrag = ({
	enabled,
	onDrop,
}: {
	enabled: boolean;
	onDrop: (files: BookSource[]) => void;
}): boolean => {
	const platform = usePlatform();
	const native = platform.capabilities.canPickLocalFiles;
	const [dragging, setDragging] = useState(false);
	const onDropRef = useRef(onDrop);
	onDropRef.current = onDrop;

	useEffect(() => {
		if (!enabled || !native) return;
		let disposed = false;
		const unlisten = platform.window.onFileDrag((event) => {
			if (disposed) return;
			// Books dragged out and dropped back would import as copies.
			if (dragOutGuard.active()) {
				setDragging(false);
				return;
			}
			setDragging(event.type === "enter");
			if (event.type === "drop" && event.files.length > 0)
				onDropRef.current(event.files);
		});
		return () => {
			disposed = true;
			setDragging(false);
			void unlisten.then((dispose) => dispose());
		};
	}, [enabled, native, platform]);

	useEffect(() => {
		if (!enabled || native) {
			setDragging(false);
			return;
		}
		let depth = 0;
		const reset = () => {
			depth = 0;
			setDragging(false);
		};
		const onEnter = (event: DragEvent) => {
			if (!carriesFiles(event) || dragOutGuard.active()) return;
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
			if (dragOutGuard.active()) return;
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
	}, [enabled, native]);

	return dragging;
};
