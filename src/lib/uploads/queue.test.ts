import { describe, expect, it } from "vitest";
import type { StagedUpload } from "@/lib/services/library";
import {
	displayName,
	emptyQueue,
	isSending,
	itemsForFiles,
	nextToUpload,
	type QueueAction,
	type QueueState,
	queueReducer,
	RejectReason,
	readyItems,
	rejectionFor,
	reviewedFromStaged,
	summarize,
	UploadPhase,
	visibleItems,
} from "./queue";

const limits = { maxFileBytes: 100, chunkBytes: 10, reviewSeconds: 3600 };
const keys = () => {
	let n = 0;
	return () => `k${++n}`;
};
const reduce = (state: QueueState, ...actions: QueueAction[]) =>
	actions.reduce(queueReducer, state);
const staged = (overrides: Partial<StagedUpload> = {}): StagedUpload => ({
	id: "s1",
	fileName: "Moby-Dick.epub",
	size: 40,
	receivedBytes: 40,
	expiresAt: "2026-10-31T12:00:00Z",
	book: {
		format: "epub",
		title: "Moby-Dick; or, The Whale",
		authorNames: ["Herman Melville"],
		identifier: "urn:isbn:9780000000002",
		publisher: "Harper",
		language: "en",
		tags: ["Sea"],
		publicationDate: "1851-10-18",
		coverUrl: "/api/uploads/s1/cover",
	},
	...overrides,
});
const coverUrl = (id: string) => `https://citadel.test/api/uploads/${id}/cover`;

describe("upload queue", () => {
	it("names files without their extension", () => {
		expect(displayName("war-and-peace.illustrated.pdf")).toBe(
			"war-and-peace.illustrated",
		);
		expect(displayName(".hidden")).toBe(".hidden");
		expect(displayName("README")).toBe("README");
	});

	it("rejects files that aren't books, are empty, or exceed the limit", () => {
		expect(rejectionFor({ name: "a.EPUB", size: 10 }, limits)).toBeUndefined();
		expect(rejectionFor({ name: "a.azw3", size: 100 }, limits)).toBeUndefined();
		expect(rejectionFor({ name: "a.docx", size: 10 }, limits)).toBe(
			RejectReason.notABook,
		);
		expect(rejectionFor({ name: "a.pdf", size: 0 }, limits)).toBe(
			RejectReason.empty,
		);
		expect(rejectionFor({ name: "a.pdf", size: 101 }, limits)).toBe(
			RejectReason.tooLarge,
		);
		// Without limits yet, the server enforces the size.
		expect(
			rejectionFor({ name: "a.pdf", size: 10_000 }, undefined),
		).toBeUndefined();
	});

	it("queues picked files, rejected ones included", () => {
		const items = itemsForFiles(
			[new File(["abc"], "Walden.azw3"), new File([""], "x.txt")],
			limits,
			keys(),
		);
		expect(items).toMatchObject([
			{ key: "k1", name: "Walden", phase: UploadPhase.waiting, size: 3 },
			{ key: "k2", phase: UploadPhase.rejected, message: RejectReason.empty },
		]);
	});

	it("walks a file from waiting to added", () => {
		const [item] = itemsForFiles(
			[new File(["0123456789"], "Book.epub")],
			limits,
			keys(),
		);
		if (!item) throw new Error("no item");
		let state = reduce(emptyQueue, { type: "filesAdded", items: [item] });
		expect(nextToUpload(state)?.key).toBe("k1");
		state = reduce(
			state,
			{
				type: "started",
				key: "k1",
				upload: staged({ book: null, receivedBytes: 0, size: 10 }),
			},
			{ type: "progressed", key: "k1", sentBytes: 4 },
			{ type: "progressed", key: "k1", sentBytes: 3 },
		);
		expect(state.items[0]).toMatchObject({
			phase: UploadPhase.uploading,
			sentBytes: 4,
		});
		expect(nextToUpload(state)).toBeUndefined();
		expect(isSending(state)).toBe(true);
		state = reduce(state, { type: "sent", key: "k1" });
		expect(state.items[0]).toMatchObject({
			phase: UploadPhase.reading,
			sentBytes: 10,
		});
		expect(isSending(state)).toBe(false);
		state = reduce(state, {
			type: "received",
			key: "k1",
			upload: staged(),
			coverUrl,
		});
		expect(state.items[0]).toMatchObject({
			phase: UploadPhase.ready,
			name: "Moby-Dick; or, The Whale",
			coverUrl: "https://citadel.test/api/uploads/s1/cover",
			expiresAt: "2026-10-31T12:00:00Z",
		});
		expect(readyItems(state)).toHaveLength(1);
		state = reduce(
			state,
			{ type: "adding", key: "k1" },
			{ type: "added", key: "k1" },
		);
		expect(visibleItems(state)).toEqual([]);
	});

	it("restores finished uploads it doesn't already have", () => {
		const state = reduce(
			emptyQueue,
			{
				type: "restored",
				uploads: [staged(), staged({ id: "s2", book: null })],
				coverUrl,
			},
			{ type: "restored", uploads: [staged()], coverUrl },
		);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({
			uploadId: "s1",
			phase: UploadPhase.ready,
		});
		expect(state.items[0]?.file).toBeUndefined();
	});

	it("only retries failed uploads it still has the file for", () => {
		const restored = reduce(emptyQueue, {
			type: "restored",
			uploads: [staged()],
			coverUrl,
		});
		const key = restored.items[0]?.key ?? "";
		const failed = reduce(restored, {
			type: "failed",
			key,
			message: "dropped",
		});
		expect(reduce(failed, { type: "retried", key }).items[0]?.phase).toBe(
			UploadPhase.failed,
		);
	});

	it("forgets a lost upload so a retry starts over", () => {
		const [item] = itemsForFiles([new File(["abc"], "a.epub")], limits, keys());
		if (!item) throw new Error("no item");
		const state = reduce(
			emptyQueue,
			{ type: "filesAdded", items: [item] },
			{
				type: "started",
				key: "k1",
				upload: staged({ book: null, receivedBytes: 2, size: 3 }),
			},
			{ type: "failed", key: "k1", message: "expired", forget: true },
			{ type: "retried", key: "k1" },
		);
		expect(state.items[0]).toMatchObject({
			phase: UploadPhase.waiting,
			uploadId: undefined,
			sentBytes: 0,
			message: undefined,
		});
	});

	it("holds the queue while paused", () => {
		const items = itemsForFiles([new File(["a"], "a.epub")], limits, keys());
		const paused = reduce(
			emptyQueue,
			{ type: "filesAdded", items },
			{ type: "paused", key: "k1", message: "full" },
		);
		expect(nextToUpload(paused)).toBeUndefined();
		expect(nextToUpload(reduce(paused, { type: "resumed" }))?.key).toBe("k1");
	});

	it("summarizes progress across files still being sent", () => {
		const items = itemsForFiles(
			[new File(["0123456789"], "a.epub"), new File(["0123456789"], "b.epub")],
			limits,
			keys(),
		);
		const state = reduce(
			emptyQueue,
			{ type: "filesAdded", items },
			{
				type: "started",
				key: "k1",
				upload: staged({ book: null, receivedBytes: 0, size: 10 }),
			},
			{ type: "progressed", key: "k1", sentBytes: 5 },
		);
		expect(summarize(state)).toEqual({
			active: 2,
			ready: 0,
			progress: 0.25,
			settled: false,
		});
		expect(summarize(emptyQueue)).toEqual({
			active: 0,
			ready: 0,
			progress: 1,
			settled: true,
		});
	});

	it("turns a staged book into the metadata it's added with", () => {
		expect(reviewedFromStaged(staged().book ?? (undefined as never))).toEqual({
			title: "Moby-Dick; or, The Whale",
			authorNames: ["Herman Melville"],
			identifier: "urn:isbn:9780000000002",
			publisher: "Harper",
			language: "en",
			tags: ["Sea"],
			publicationDate: "1851-10-18",
		});
	});
});
