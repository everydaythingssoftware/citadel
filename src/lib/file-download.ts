/** One file's download from the server, as its row shows it. */
export type FileDownloadState =
	| { status: "idle" }
	/** `total` is null when the server didn't say how big the file is. */
	| { status: "downloading"; received: number; total: number | null }
	| { status: "done" }
	| { status: "failed"; message: string };

export type FileDownloadEvent =
	| { type: "start" }
	| { type: "progress"; received: number; total: number | null }
	| { type: "complete" }
	| { type: "fail"; message: string }
	| { type: "cancel" };

export const IDLE_DOWNLOAD: FileDownloadState = { status: "idle" };

export const fileDownloadReducer = (
	state: FileDownloadState,
	event: FileDownloadEvent,
): FileDownloadState => {
	switch (event.type) {
		case "start":
			return state.status === "downloading"
				? state
				: { status: "downloading", received: 0, total: null };
		case "progress":
			if (state.status !== "downloading") return state;
			return {
				status: "downloading",
				received: Math.max(state.received, event.received),
				total: event.total ?? state.total,
			};
		case "complete":
			return state.status === "downloading" ? { status: "done" } : state;
		case "fail":
			return state.status === "downloading"
				? { status: "failed", message: event.message }
				: state;
		case "cancel":
			return state.status === "downloading" ? IDLE_DOWNLOAD : state;
	}
};

/** 0–1 while the size is known; null for an indeterminate download. */
export const downloadFraction = (state: FileDownloadState): number | null => {
	if (state.status === "done") return 1;
	if (state.status !== "downloading" || !state.total) return null;
	return Math.min(1, state.received / state.total);
};

const UNITS = ["KB", "MB", "GB"] as const;

/** "840 bytes", "12 KB", "2.1 MB": the way Finder rounds sizes (base 1000). */
export const formatByteSize = (bytes: number): string => {
	if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
	let value = bytes;
	let unit: (typeof UNITS)[number] = "KB";
	for (const next of UNITS) {
		value /= 1000;
		unit = next;
		if (value < 1000) break;
	}
	const digits = value < 10 && unit !== "KB" ? 1 : 0;
	return `${value.toFixed(digits)} ${unit}`;
};

const splitUnit = (size: string): [string, string] => {
	const space = size.lastIndexOf(" ");
	return [size.slice(0, space), size.slice(space + 1)];
};

/** "3.9 of 8.4 MB", or just "3.9 MB" while the total is unknown. */
export const downloadProgressText = (
	received: number,
	total: number | null,
): string => {
	const done = formatByteSize(received);
	if (total === null) return done;
	const whole = formatByteSize(total);
	const [doneValue, doneUnit] = splitUnit(done);
	return doneUnit === splitUnit(whole)[1]
		? `${doneValue} of ${whole}`
		: `${done} of ${whole}`;
};
