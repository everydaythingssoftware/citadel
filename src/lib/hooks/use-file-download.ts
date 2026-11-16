import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithProgress, saveBlob } from "@/lib/download";
import {
	type FileDownloadEvent,
	type FileDownloadState,
	fileDownloadReducer,
	IDLE_DOWNLOAD,
} from "@/lib/file-download";

export interface FileDownloads {
	stateOf(key: string): FileDownloadState;
	/** Downloads the file in the page, then saves it as `filename`. */
	start(key: string, url: string, filename: string): void;
	cancel(key: string): void;
}

const failureMessage = (error: unknown): string =>
	error instanceof TypeError
		? "Couldn't reach the server"
		: "Couldn't download";

/**
 * Downloads files with progress, one state per row key, so a row can draw
 * its own ring and show its own failure. Leaving cancels what's running.
 */
export const useFileDownloads = (): FileDownloads => {
	const [states, setStates] = useState<Record<string, FileDownloadState>>({});
	const controllers = useRef(new Map<string, AbortController>());

	const dispatch = useCallback((key: string, event: FileDownloadEvent) => {
		setStates((previous) => {
			const current = previous[key] ?? IDLE_DOWNLOAD;
			const next = fileDownloadReducer(current, event);
			return next === current ? previous : { ...previous, [key]: next };
		});
	}, []);

	useEffect(() => {
		const running = controllers.current;
		return () => {
			for (const controller of running.values()) controller.abort();
			running.clear();
		};
	}, []);

	const start = useCallback(
		(key: string, url: string, filename: string) => {
			if (controllers.current.has(key)) return;
			const controller = new AbortController();
			controllers.current.set(key, controller);
			dispatch(key, { type: "start" });
			fetchWithProgress(url, {
				signal: controller.signal,
				onProgress: (progress) =>
					dispatch(key, { type: "progress", ...progress }),
			})
				.then((blob) => {
					saveBlob(blob, filename);
					dispatch(key, { type: "complete" });
				})
				.catch((error: unknown) => {
					dispatch(
						key,
						controller.signal.aborted
							? { type: "cancel" }
							: { type: "fail", message: failureMessage(error) },
					);
				})
				.finally(() => {
					if (controllers.current.get(key) === controller)
						controllers.current.delete(key);
				});
		},
		[dispatch],
	);

	const cancel = useCallback((key: string) => {
		controllers.current.get(key)?.abort();
	}, []);

	const stateOf = useCallback(
		(key: string) => states[key] ?? IDLE_DOWNLOAD,
		[states],
	);

	return { stateOf, start, cancel };
};
