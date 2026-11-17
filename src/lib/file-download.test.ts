import { describe, expect, it } from "vitest";
import {
	downloadFraction,
	downloadProgressText,
	type FileDownloadState,
	fileDownloadReducer,
	formatByteSize,
	IDLE_DOWNLOAD,
} from "./file-download";

const downloading = (
	received: number,
	total: number | null,
): FileDownloadState => ({ status: "downloading", received, total });

describe("fileDownloadReducer", () => {
	it("starts from idle, done or failed", () => {
		const started = downloading(0, null);
		expect(fileDownloadReducer(IDLE_DOWNLOAD, { type: "start" })).toEqual(
			started,
		);
		expect(fileDownloadReducer({ status: "done" }, { type: "start" })).toEqual(
			started,
		);
		expect(
			fileDownloadReducer(
				{ status: "failed", message: "x" },
				{ type: "start" },
			),
		).toEqual(started);
	});

	it("ignores a second start while downloading", () => {
		const state = downloading(10, 100);
		expect(fileDownloadReducer(state, { type: "start" })).toBe(state);
	});

	it("tracks progress without going backwards", () => {
		let state = fileDownloadReducer(IDLE_DOWNLOAD, { type: "start" });
		state = fileDownloadReducer(state, {
			type: "progress",
			received: 40,
			total: 100,
		});
		expect(state).toEqual(downloading(40, 100));
		state = fileDownloadReducer(state, {
			type: "progress",
			received: 30,
			total: null,
		});
		expect(state).toEqual(downloading(40, 100));
	});

	it("ignores progress, completion and failure when not downloading", () => {
		for (const event of [
			{ type: "progress", received: 1, total: 2 },
			{ type: "complete" },
			{ type: "fail", message: "x" },
			{ type: "cancel" },
		] as const) {
			expect(fileDownloadReducer(IDLE_DOWNLOAD, event)).toBe(IDLE_DOWNLOAD);
		}
	});

	it("finishes, fails or cancels a download", () => {
		const state = downloading(40, 100);
		expect(fileDownloadReducer(state, { type: "complete" })).toEqual({
			status: "done",
		});
		expect(
			fileDownloadReducer(state, { type: "fail", message: "Offline" }),
		).toEqual({ status: "failed", message: "Offline" });
		expect(fileDownloadReducer(state, { type: "cancel" })).toEqual(
			IDLE_DOWNLOAD,
		);
	});
});

describe("downloadFraction", () => {
	it("is known only with a total", () => {
		expect(downloadFraction(downloading(40, 100))).toBe(0.4);
		expect(downloadFraction(downloading(40, null))).toBeNull();
		expect(downloadFraction(downloading(0, 0))).toBeNull();
		expect(downloadFraction(IDLE_DOWNLOAD)).toBeNull();
		expect(downloadFraction({ status: "done" })).toBe(1);
	});

	it("never passes 1 when a compressed size undercounts", () => {
		expect(downloadFraction(downloading(150, 100))).toBe(1);
	});
});

describe("formatByteSize", () => {
	it("rounds like Finder", () => {
		expect(formatByteSize(1)).toBe("1 byte");
		expect(formatByteSize(840)).toBe("840 bytes");
		expect(formatByteSize(12_400)).toBe("12 KB");
		expect(formatByteSize(2_140_000)).toBe("2.1 MB");
		expect(formatByteSize(48_200_000)).toBe("48 MB");
		expect(formatByteSize(1_300_000_000)).toBe("1.3 GB");
	});
});

describe("downloadProgressText", () => {
	it("shares the unit when both sizes use it", () => {
		expect(downloadProgressText(3_900_000, 8_400_000)).toBe("3.9 of 8.4 MB");
	});

	it("names both units when they differ", () => {
		expect(downloadProgressText(400_000, 8_400_000)).toBe("400 KB of 8.4 MB");
	});

	it("shows what arrived when the total is unknown", () => {
		expect(downloadProgressText(3_900_000, null)).toBe("3.9 MB");
	});
});
