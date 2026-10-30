import { useEffect } from "react";
import { isSending } from "@/lib/uploads/queue";
import { useLibraryActions, useLibraryStore } from "@/stores/library/store";
import { useUploadsStore } from "@/stores/uploads/store";

/**
 * Connects the upload queue to the open library's uploads and warns before
 * the page closes while files are still being sent. Mount once.
 */
export const useBookUploads = (): void => {
	const uploads = useLibraryStore((state) => state.library?.uploads);
	const actions = useLibraryActions();
	const connect = useUploadsStore((state) => state.connect);

	useEffect(() => {
		connect(uploads, () => actions.invalidateBooks());
	}, [uploads, connect, actions]);

	useEffect(() => {
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!isSending(useUploadsStore.getState().queue)) return;
			event.preventDefault();
			// Older browsers only prompt when a return value is set.
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);
};
