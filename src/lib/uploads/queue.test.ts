import { describe, expect, it } from "vitest";
import type { StagedUpload } from "@/lib/services/library";
import {
	displayName,
	duplicateGroups,
	emptyQueue,
	isBatchRead,
	isSending,
	itemsForFiles,
	nextToUpload,
	type QueueAction,
	type QueueState,
	queueReducer,
	RejectReason,
	readQueue,
	readyItems,
	rejectionFor,
	reviewedFromStaged,
	summarize,
	undecidedDuplicates,
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
		titleKey: "moby dick or the whale",
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

	it("queues files on this computer by path, checking only their format", () => {
		const items = itemsForFiles(
			[
				{ path: "/books/Walden.epub", name: "Walden.epub" },
				{ path: "C:\\Books\\notes.docx", name: "notes.docx" },
			],
			limits,
			keys(),
		);
		expect(items).toMatchObject([
			{
				key: "k1",
				name: "Walden",
				path: "/books/Walden.epub",
				phase: UploadPhase.waiting,
				size: 0,
			},
			{
				key: "k2",
				phase: UploadPhase.rejected,
				message: RejectReason.notABook,
			},
		]);
		expect(items[0]?.file).toBeUndefined();
		expect(nextToUpload({ items })?.key).toBe("k1");
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

	it("flags a received upload whose title is already in the library", () => {
		const message = "Already in your library: Moby-Dick";
		const state = reduce(emptyQueue, {
			type: "restored",
			uploads: [
				staged({
					duplicate: message,
					book: {
						format: "epub",
						title: " Moby-Dick ",
						titleKey: "moby dick",
						authorNames: [],
						identifier: null,
						publisher: null,
						language: null,
						tags: [],
						publicationDate: null,
						coverUrl: null,
					},
				}),
			],
			coverUrl,
		});
		expect(state.items[0]).toMatchObject({
			phase: UploadPhase.ready,
			duplicate: { title: "Moby-Dick", message },
		});
		expect(state.items[0]?.message).toBeUndefined();
	});

	const read = (...books: [id: string, title: string, duplicate?: string][]) =>
		reduce(emptyQueue, {
			type: "restored",
			uploads: books.map(([id, title, duplicate]) =>
				staged({
					id,
					duplicate,
					book: {
						format: "epub",
						title,
						titleKey: title.toLowerCase(),
						authorNames: [],
						tags: [],
					},
				}),
			),
			coverUrl,
		});
	const keyOf = (state: QueueState, id: string) =>
		state.items.find((item) => item.uploadId === id)?.key ?? "";
	const asked = (state: QueueState) =>
		undecidedDuplicates(state).map((item) => item.uploadId);

	it("asks about books in the library and later copies in the queue", () => {
		const state = read(
			["a", "Germinal", "Already in your library: Germinal"],
			["b", "Nana"],
			["c", "La Débâcle"],
			["d", "LA DÉBÂCLE"],
			["e", "La Débâcle"],
		);
		const skipping = (...ids: string[]) =>
			asked({
				items: state.items.filter((item) => !ids.includes(item.uploadId ?? "")),
			});
		expect(skipping()).toEqual(["a", "d", "e"]);
		expect(skipping("d")).toEqual(["a", "e"]);
		expect(skipping("c")).toEqual(["a", "e"]);
		expect(skipping("a", "c", "d")).toEqual([]);
	});

	it("asks once per book, saying how many copies", () => {
		const library = "Already in your library: Germinal by Émile Zola";
		const state = read(
			["a", "Germinal", library],
			["b", "La Débâcle"],
			["c", "Germinal", library],
			["d", "Nana", "Already in your library: Nana by Émile Zola"],
			["e", "LA DÉBÂCLE"],
			["f", "La Débâcle"],
			["g", "Kim"],
			["h", "Kim"],
			["i", "Bel-Ami"],
		);
		expect(
			duplicateGroups(undecidedDuplicates(state)).map((group) => [
				group.items.map((item) => item.uploadId),
				group.message,
			]),
		).toEqual([
			[["a", "c"], "Already in your library, 2 copies"],
			[["d"], "Already in your library: Nana by Émile Zola"],
			[["e", "f"], "2 extra copies in the books you are adding"],
			[["h"], "1 extra copy in the books you are adding"],
		]);
	});

	it("never asks about a duplicate again once it's accepted or refused", () => {
		const state = read(
			["a", " Germinal ", "Already in your library: Germinal"],
			["b", "Nana"],
			["c", "Nana"],
			["d", "Kim"],
		);
		const accepted = reduce(
			state,
			{ type: "accepted", key: keyOf(state, "a") },
			{ type: "accepted", key: keyOf(state, "c") },
		);
		expect(asked(accepted)).toEqual([]);
		expect(accepted.items[0]).toMatchObject({
			phase: UploadPhase.ready,
			duplicate: undefined,
			acceptedTitle: "Germinal",
		});
		const refused = reduce(accepted, {
			type: "addFailed",
			key: keyOf(state, "d"),
			duplicate: { title: "Kim", message: "Already in your library: Kim" },
		});
		expect(asked(refused)).toEqual([]);
		expect(refused.items[3]?.duplicate?.title).toBe("Kim");
	});

	it("asks about a copy of a book added since, while its batch lasts", () => {
		const state = read(["a", "Nana"], ["b", "Nana"]);
		const added = reduce(state, { type: "added", key: keyOf(state, "a") });
		expect(asked(added)).toEqual(["b"]);
		const later = reduce(
			added,
			{ type: "removed", key: keyOf(state, "b") },
			{ type: "filesAdded", items: [] },
		);
		expect(later.items).toEqual([]);
	});

	it("is read once no file is on its way, or a full server holds the rest back", () => {
		const [item] = itemsForFiles([new File(["a"], "a.epub")], limits, keys());
		if (!item) throw new Error("no item");
		expect(isBatchRead({ items: [item] })).toBe(false);
		expect(isBatchRead({ items: [item], paused: "Full" })).toBe(true);
		const reading = { ...item, phase: UploadPhase.reading };
		expect(isBatchRead({ items: [reading], paused: "Full" })).toBe(false);
		expect(isBatchRead(read(["a", "Nana"]))).toBe(true);
	});

	it("holds back a batch on this computer until all of it is read", () => {
		const items = itemsForFiles(
			[
				{ path: "/a.epub", name: "a.epub" },
				{ path: "/b.epub", name: "b.epub" },
				new File(["c"], "c.epub"),
			],
			limits,
			keys(),
		);
		const decided = read(["z", "Nana"]);
		const reading = reduce(
			decided,
			{ type: "filesAdded", items: items.slice(0, 2) },
			{ type: "received", key: "k1", upload: staged(), coverUrl },
		);
		const shown = (state: QueueState) =>
			visibleItems(readQueue(state)).map((item) => item.name);
		expect(shown(reading)).toEqual(["Nana"]);
		expect(readyItems(reading)).toHaveLength(1);
		const done = reduce(reading, {
			type: "rejected",
			key: "k2",
			message: "No book",
		});
		expect(shown(done)).toEqual(["Nana", "Moby-Dick; or, The Whale", "b"]);
		expect(readyItems(done)).toHaveLength(2);
		const uploading = reduce(done, {
			type: "filesAdded",
			items: items.slice(2),
		});
		expect(shown(uploading)).toContain("c");
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
		});
		expect(summarize(emptyQueue)).toEqual({
			active: 0,
			ready: 0,
			progress: 1,
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
