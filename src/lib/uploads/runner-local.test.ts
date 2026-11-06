import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import {
	type LocalBookImports,
	type ReviewedBook,
	type StagedUpload,
	UploadError,
	UploadFailure,
} from "@/lib/services/library";
import {
	emptyQueue,
	type QueueAction,
	type QueueState,
	queueReducer,
	UploadPhase,
} from "./queue";
import { createUploadRunner } from "./runner";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++)
		await settle();
	expect(condition()).toBe(true);
};

const local = (path: string) => ({
	path,
	name: path.split("/").pop() ?? path,
});

/** Stages files by path the way the desktop backend does, in memory. */
const createFakeImports = () => {
	const staged = new Map<string, { path: string; upload: StagedUpload }>();
	const committed: { path: string; book: ReviewedBook }[] = [];
	const refused = new Map<string, string>();
	let hold: Promise<void> | undefined;
	let next = 0;
	const imports: LocalBookImports = {
		list: async () => ({
			uploads: [...staged.values()].map(({ upload }) => upload),
		}),
		stage: async (path) => {
			await hold;
			const reason = refused.get(path);
			if (reason) throw new UploadError(UploadFailure.invalid, reason);
			const id = `staged-${++next}`;
			const fileName = path.split("/").pop() ?? path;
			const upload: StagedUpload = {
				id,
				fileName,
				size: 42,
				receivedBytes: 42,
				book: {
					format: "epub",
					title: `${fileName} (read)`,
					authorNames: ["Ann Author"],
					tags: [],
					coverUrl: `asset://covers/${id}.jpg`,
				},
			};
			staged.set(id, { path, upload });
			return upload;
		},
		coverUrl: (id) => `asset://covers/${id}.jpg`,
		commit: async (id, book) => {
			const entry = staged.get(id);
			if (!entry) throw new Error("This book is no longer waiting");
			staged.delete(id);
			committed.push({ path: entry.path, book });
			return { id: "1" } as LibraryBook;
		},
		cancel: async (id) => {
			staged.delete(id);
		},
	};
	return {
		imports,
		staged,
		committed,
		refuse: (path: string, reason: string) => refused.set(path, reason),
		/** Holds every stage call until the returned function is called. */
		pause: () => {
			let release = () => {};
			hold = new Promise((resolve) => {
				release = () => {
					hold = undefined;
					resolve();
				};
			});
			return release;
		},
	};
};

const setup = () => {
	const fake = createFakeImports();
	let state: QueueState = emptyQueue;
	const actions: QueueAction["type"][] = [];
	let added = 0;
	const runner = createUploadRunner({
		uploads: fake.imports,
		getState: () => state,
		dispatch: (action) => {
			actions.push(action.type);
			state = queueReducer(state, action);
		},
		onBookAdded: () => {
			added += 1;
		},
	});
	return {
		fake,
		runner,
		actions,
		state: () => state,
		phases: () => state.items.map((item) => item.phase),
		added: () => added,
	};
};

describe("upload runner, files on this computer", () => {
	it("reads chosen files where they are and readies them for review", async () => {
		const queue = setup();
		await queue.runner.restore();
		queue.runner.addFiles([
			local("/books/Walden.epub"),
			local("/books/Moby Dick.epub"),
		]);
		await until(() =>
			queue.phases().every((phase) => phase === UploadPhase.ready),
		);
		expect(queue.state().items[0]).toMatchObject({
			path: "/books/Walden.epub",
			name: "Walden.epub (read)",
			size: 42,
			coverUrl: "asset://covers/staged-1.jpg",
		});
		expect(queue.state().limits).toBeUndefined();
		expect(queue.actions).not.toContain("started");
		expect(queue.actions).toContain("reading");
	});

	it("adds a reviewed book from its file", async () => {
		const queue = setup();
		queue.runner.addFiles([local("/books/Walden.epub")]);
		await until(() => queue.phases()[0] === UploadPhase.ready);
		const key = queue.state().items[0]?.key ?? "";
		const book: ReviewedBook = {
			title: "Walden",
			authorNames: ["Henry David Thoreau"],
			tags: [],
		};
		expect(await queue.runner.add(key, book)).toBe(true);
		expect(queue.fake.committed).toEqual([
			{ path: "/books/Walden.epub", book },
		]);
		expect(queue.phases()).toEqual([UploadPhase.added]);
		expect(queue.added()).toBe(1);
	});

	it("rejects files that can't be books, and keeps going", async () => {
		const queue = setup();
		queue.fake.refuse("/books/fake.epub", "This isn't a book Citadel can add");
		queue.runner.addFiles([
			local("/books/notes.docx"),
			local("/books/fake.epub"),
			local("/books/Walden.epub"),
		]);
		await until(() => queue.phases()[2] === UploadPhase.ready);
		expect(queue.state().items.slice(0, 2)).toMatchObject([
			{ phase: UploadPhase.rejected },
			{
				phase: UploadPhase.rejected,
				message: "This isn't a book Citadel can add",
			},
		]);
	});

	it("discards a book removed while it was being read", async () => {
		const queue = setup();
		const release = queue.fake.pause();
		queue.runner.addFiles([local("/books/Walden.epub")]);
		await until(() => queue.phases()[0] === UploadPhase.reading);
		await queue.runner.remove(queue.state().items[0]?.key ?? "");
		release();
		await settle();
		await settle();
		expect(queue.state().items).toEqual([]);
		expect(queue.fake.staged.size).toBe(0);
	});

	it("restores books still waiting for review", async () => {
		const first = setup();
		const imports = first.fake.imports;
		await imports.stage("/books/Walden.epub");
		await first.runner.restore();
		expect(first.state().items).toMatchObject([
			{
				uploadId: "staged-1",
				phase: UploadPhase.ready,
				coverUrl: "asset://covers/staged-1.jpg",
			},
		]);
		expect(first.fake.staged.size).toBe(1);
	});
});
