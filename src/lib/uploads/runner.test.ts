import { describe, expect, it } from "vitest";
import { UploadError, UploadFailure } from "@/lib/services/library";
import { createFakeUploads, type FakeUploadsOptions } from "./fake-uploads";
import {
	emptyQueue,
	type QueueAction,
	type QueueState,
	queueReducer,
	RejectReason,
	UploadPhase,
} from "./queue";
import { createUploadRunner, PAUSED_MESSAGE } from "./runner";

const file = (name: string, text: string) => new File([text], name);

/** Waits until queued promise chains (fake timers aside) have settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) await settle();
	expect(condition()).toBe(true);
};

const setup = (options: FakeUploadsOptions = {}) => {
	const fake = createFakeUploads(options);
	let state: QueueState = emptyQueue;
	const actions: QueueAction["type"][] = [];
	const sleeps: number[] = [];
	let added = 0;
	const runner = createUploadRunner({
		uploads: fake.uploads,
		getState: () => state,
		dispatch: (action) => {
			actions.push(action.type);
			state = queueReducer(state, action);
		},
		onBookAdded: () => {
			added += 1;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return {
		fake,
		runner,
		actions,
		sleeps,
		state: () => state,
		phases: () => state.items.map((item) => item.phase),
		added: () => added,
	};
};

describe("upload runner", () => {
	it("restores limits and finished uploads, discarding unfinished ones", async () => {
		const queue = setup({ limits: { maxFileBytes: 50 } });
		const finished = queue.fake.seed("Finished.epub", 10, true);
		queue.fake.seed("Half.epub", 10, false);
		await queue.runner.restore();
		expect(queue.state().limits?.maxFileBytes).toBe(50);
		expect(queue.state().items).toHaveLength(1);
		expect(queue.state().items[0]).toMatchObject({
			uploadId: finished,
			phase: UploadPhase.ready,
			name: "Finished (read)",
			coverUrl: `https://citadel.test/api/uploads/${finished}/cover`,
		});
		expect([...queue.fake.staged.keys()]).toEqual([finished]);
	});

	it("uploads files one at a time in chunks and readies them for review", async () => {
		const queue = setup();
		await queue.runner.restore();
		queue.runner.addFiles([file("One.epub", "abcdefghij"), file("Two.epub", "klmno")]);
		await until(() => queue.phases().every((phase) => phase === UploadPhase.ready));
		const [one, two] = queue.state().items;
		expect(one).toMatchObject({ name: "One (read)", sentBytes: 10 });
		expect(two).toMatchObject({ name: "Two (read)", sentBytes: 5 });
		// Three chunks of four bytes for the first file, two for the second.
		expect(queue.fake.calls.filter((call) => call === "sendChunk")).toHaveLength(5);
		expect(queue.actions).toContain("sent");
	});

	it("starts the next file while the server reads the previous one", async () => {
		let release: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queue = setup({ readDelay: () => reading });
		queue.runner.addFiles([file("One.epub", "abcd"), file("Two.epub", "efgh")]);
		await until(() => queue.phases()[1] !== UploadPhase.waiting);
		expect(queue.phases()[0]).toBe(UploadPhase.reading);
		release();
		await until(() => queue.phases().every((phase) => phase === UploadPhase.ready));
	});

	it("rejects files that can't be uploaded before sending anything", async () => {
		const queue = setup({ limits: { maxFileBytes: 5 } });
		await queue.runner.restore();
		queue.runner.addFiles([
			file("Big.epub", "0123456789"),
			file("Notes.docx", "abc"),
			file("Empty.pdf", ""),
		]);
		expect(queue.state().items.map((item) => item.message)).toEqual([
			RejectReason.tooLarge,
			RejectReason.notABook,
			RejectReason.empty,
		]);
		await settle();
		expect(queue.fake.calls).not.toContain("create");
	});

	it("resumes from the server's offset after a dropped connection", async () => {
		const queue = setup();
		queue.fake.failNext(
			"sendChunk",
			new UploadError(UploadFailure.network, "dropped"),
			new UploadError(UploadFailure.network, "dropped again"),
		);
		queue.runner.addFiles([file("One.epub", "abcdefgh")]);
		await until(() => queue.phases()[0] === UploadPhase.ready);
		expect(queue.sleeps).toEqual([1000, 2000]);
		expect(queue.fake.calls.filter((call) => call === "status")).toHaveLength(2);
	});

	it("gives up after repeated failures and retries on request", async () => {
		const queue = setup();
		const dropped = () => new UploadError(UploadFailure.network, "dropped");
		queue.fake.failNext("sendChunk", dropped(), dropped(), dropped(), dropped());
		queue.runner.addFiles([file("One.epub", "abcd")]);
		await until(() => queue.phases()[0] === UploadPhase.failed);
		expect(queue.sleeps).toEqual([1000, 2000, 4000]);
		expect(queue.state().items[0]?.message).toMatch(/connection dropped/);
		queue.runner.retry(queue.state().items[0]?.key ?? "");
		await until(() => queue.phases()[0] === UploadPhase.ready);
	});

	it("picks up from the server's offset after a conflict without waiting", async () => {
		const queue = setup();
		queue.fake.failNext("sendChunk", new UploadError(UploadFailure.conflict, "moved"));
		queue.runner.addFiles([file("One.epub", "abcd")]);
		await until(() => queue.phases()[0] === UploadPhase.ready);
		expect(queue.sleeps).toEqual([]);
	});

	it("starts over when the server has forgotten an upload", async () => {
		const queue = setup();
		const dropped = () => new UploadError(UploadFailure.network, "dropped");
		queue.fake.failNext("sendChunk", dropped());
		queue.fake.failNext("status", new UploadError(UploadFailure.notFound, "gone"));
		queue.runner.addFiles([file("One.epub", "abcd")]);
		await until(() => queue.phases()[0] === UploadPhase.failed);
		expect(queue.state().items[0]).toMatchObject({ uploadId: undefined, sentBytes: 0 });
		queue.runner.retry(queue.state().items[0]?.key ?? "");
		await until(() => queue.phases()[0] === UploadPhase.ready);
	});

	it("marks a file the server won't take as rejected", async () => {
		const queue = setup();
		queue.fake.failNext(
			"sendChunk",
			new UploadError(UploadFailure.invalid, "This isn't a valid EPUB file"),
		);
		queue.runner.addFiles([file("One.epub", "abcd")]);
		await until(() => queue.phases()[0] === UploadPhase.rejected);
		expect(queue.state().items[0]?.message).toBe("This isn't a valid EPUB file");
	});

	it("pauses when the server is full and carries on once a book is added", async () => {
		const queue = setup({ maxUploads: 1 });
		queue.runner.addFiles([file("One.epub", "abcd"), file("Two.epub", "efgh")]);
		await until(() => queue.state().paused === PAUSED_MESSAGE);
		expect(queue.phases()).toEqual([UploadPhase.ready, UploadPhase.waiting]);
		const [one] = queue.state().items;
		expect(await queue.runner.add(one?.key ?? "", { title: "One" })).toBe(true);
		await until(() => queue.phases()[1] === UploadPhase.ready);
		expect(queue.state().paused).toBeUndefined();
	});

	it("adds reviewed books, reporting failures without losing them", async () => {
		const queue = setup();
		queue.runner.addFiles([file("One.epub", "abcd")]);
		await until(() => queue.phases()[0] === UploadPhase.ready);
		const key = queue.state().items[0]?.key ?? "";
		queue.fake.failNext("commit", new UploadError(UploadFailure.readOnly, "read-only"));
		expect(await queue.runner.add(key, { title: "Edited" })).toBe(false);
		expect(queue.state().items[0]).toMatchObject({
			phase: UploadPhase.ready,
			message: "This library can't take new books right now.",
		});
		expect(await queue.runner.add(key, { title: "Edited" })).toBe(true);
		expect(queue.phases()).toEqual([UploadPhase.added]);
		expect(queue.fake.committed[0]?.book.title).toBe("Edited");
		expect(queue.added()).toBe(1);
	});

	it("adds every ready book with the metadata read from its file", async () => {
		const queue = setup();
		queue.runner.addFiles([file("One.epub", "abcd"), file("Two.epub", "efgh")]);
		await until(() => queue.phases().every((phase) => phase === UploadPhase.ready));
		await queue.runner.addAllReady();
		expect(queue.fake.committed.map(({ book }) => book.title)).toEqual([
			"One (read)",
			"Two (read)",
		]);
		expect(queue.fake.committed[0]?.book.authorNames).toEqual(["An Author"]);
	});

	it("removes an upload mid-transfer and discards it on the server", async () => {
		let release: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queue = setup({ readDelay: () => reading });
		queue.runner.addFiles([file("One.epub", "abcd")]);
		await until(() => queue.phases()[0] === UploadPhase.reading);
		await queue.runner.remove(queue.state().items[0]?.key ?? "");
		release();
		await settle();
		expect(queue.state().items).toEqual([]);
		expect(queue.fake.staged.size).toBe(0);
	});
});
