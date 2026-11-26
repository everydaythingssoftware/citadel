import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import type { LocalBookImports, StagedUpload } from "@/lib/services/library";
import { createFakeUploads } from "@/lib/uploads/fake-uploads";
import {
	isBatchRead,
	isSending,
	readQueue,
	undecidedDuplicates,
} from "@/lib/uploads/queue";
import { useUploadsStore } from "./store";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++)
		await settle();
	expect(condition()).toBe(true);
};

/** Reads files by path in memory; a file's name is its book's title. */
const createImports = () => {
	const staged = new Map<string, StagedUpload>();
	const committed: string[] = [];
	let next = 0;
	const imports: LocalBookImports = {
		list: async () => ({ uploads: [...staged.values()] }),
		stage: async (path) => {
			const id = `staged-${++next}`;
			const title = (path.split("/").pop() ?? path).replace(/\.epub$/, "");
			const upload: StagedUpload = {
				id,
				fileName: `${title}.epub`,
				size: 42,
				receivedBytes: 42,
				book: {
					format: "epub",
					title,
					titleKey: title,
					authorNames: [],
					tags: [],
				},
			};
			staged.set(id, upload);
			return upload;
		},
		coverUrl: (id) => `asset://covers/${id}.jpg`,
		commit: async (id) => {
			committed.push(id);
			return { id: "1" } as LibraryBook;
		},
		cancel: async (id) => {
			staged.delete(id);
		},
	};
	return { imports, staged, committed };
};

const files = (...paths: string[]) =>
	paths.map((path) => ({ path, name: path.split("/").pop() ?? path }));

const shown = () => {
	const read = readQueue(useUploadsStore.getState().queue);
	return {
		names: read.items.map((item) => item.name),
		duplicates: undecidedDuplicates(read).map((item) => item.name),
	};
};

describe("uploads store", () => {
	it("drops the whole batch when the sheet closes on the duplicates step", async () => {
		const fake = createImports();
		const store = useUploadsStore.getState();
		store.connect(fake.imports, () => {});
		await settle();
		store.addFiles(
			files("/a/Germinal.epub", "/b/Germinal.epub", "/a/Nana.epub"),
		);
		await until(() => isBatchRead(useUploadsStore.getState().queue));
		expect(shown().duplicates).toEqual(["Germinal"]);

		useUploadsStore.getState().dismissSheet();
		expect(useUploadsStore.getState().sheetOpen).toBe(false);

		useUploadsStore.getState().addFiles(files("/c/Bel-Ami.epub"));
		await until(() => isBatchRead(useUploadsStore.getState().queue));
		expect(shown()).toEqual({ names: ["Bel-Ami"], duplicates: [] });
		expect(useUploadsStore.getState().sheetOpen).toBe(true);
		expect(fake.staged.size).toBe(1);
		expect(fake.committed).toEqual([]);
	});

	it("drops a batch of ready books when the sheet closes, so the next add shows only its own", async () => {
		const fake = createImports();
		useUploadsStore.getState().connect(fake.imports, () => {});
		await settle();
		useUploadsStore.getState().addFiles(files("/a/Germinal.epub"));
		await until(() => isBatchRead(useUploadsStore.getState().queue));
		expect(shown()).toEqual({ names: ["Germinal"], duplicates: [] });

		useUploadsStore.getState().dismissSheet();
		expect(useUploadsStore.getState().sheetOpen).toBe(false);

		useUploadsStore.getState().addFiles(files("/b/Boule de Suif.epub"));
		await until(() => isBatchRead(useUploadsStore.getState().queue));
		expect(shown().names).toEqual(["Boule de Suif"]);
		expect(fake.staged.size).toBe(1);
	});

	it("drops the batch when the sheet closes on a review card or while reading", async () => {
		const fake = createImports();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stage = fake.imports.stage;
		useUploadsStore.getState().connect(fake.imports, () => {});
		await settle();
		useUploadsStore.getState().addFiles(files("/a/Nana.epub"));
		await until(() => isBatchRead(useUploadsStore.getState().queue));
		const [nana] = useUploadsStore.getState().queue.items;
		useUploadsStore.getState().review(nana?.key ?? null);
		useUploadsStore.getState().dismissSheet();
		expect(useUploadsStore.getState().queue.items).toEqual([]);

		fake.imports.stage = async (path) => {
			await held;
			return stage(path);
		};
		useUploadsStore
			.getState()
			.addFiles(files("/b/Bel-Ami.epub", "/c/Thérèse Raquin.epub"));
		await settle();
		useUploadsStore.getState().dismissSheet();
		release();
		await until(() => fake.staged.size === 0);
		expect(useUploadsStore.getState().queue.items).toEqual([]);
	});

	it("keeps the queue when the sheet closes while files are being sent", async () => {
		let release = () => {};
		const fake = createFakeUploads({
			chunkDelay: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		useUploadsStore.getState().connect(fake.uploads, () => {});
		await settle();
		useUploadsStore
			.getState()
			.addFiles([new File(["Germinal"], "Germinal.epub")]);
		await until(() => isSending(useUploadsStore.getState().queue));

		useUploadsStore.getState().dismissSheet();
		expect(useUploadsStore.getState().sheetOpen).toBe(false);
		expect(
			useUploadsStore.getState().queue.items.map((item) => item.name),
		).toEqual(["Germinal"]);
		release();
	});
});
