import type { LibraryBook } from "@/bindings";
import {
	type BookUploads,
	type ReviewedBook,
	type StagedUpload,
	UploadError,
	UploadFailure,
	type UploadLimits,
} from "@/lib/services/library";
import { displayName } from "./queue";

interface FakeUpload {
	id: string;
	fileName: string;
	size: number;
	received: number;
	expiresAt: string;
	/** Read; set once the last byte arrives. */
	ready: boolean;
}

export interface FakeUploadsOptions {
	limits?: Partial<UploadLimits>;
	/** How many uploads the server holds before refusing more. */
	maxUploads?: number;
	/** Delay before each chunk's response, after its bytes are "sent". */
	readDelay?: () => Promise<void>;
	/** Delay while each chunk's bytes go out, reporting progress halfway. */
	chunkDelay?: () => Promise<void>;
	now?: () => Date;
	/** Whether read books report a cover (stories have no image to serve). */
	withCovers?: boolean;
}

/**
 * An in-memory stand-in for the server's upload API, for tests and stories.
 * `failNext` makes the next calls of a method throw.
 */
export const createFakeUploads = ({
	limits,
	maxUploads = 100,
	readDelay,
	chunkDelay,
	now = () => new Date(),
	withCovers = true,
}: FakeUploadsOptions = {}) => {
	const staged = new Map<string, FakeUpload>();
	const committed: { uploadId: string; book: ReviewedBook }[] = [];
	const failures: Partial<Record<keyof BookUploads, UploadError[]>> = {};
	const calls: string[] = [];
	const fullLimits: UploadLimits = {
		maxFileBytes: 200 * 1024 * 1024,
		chunkBytes: 4,
		reviewSeconds: 24 * 60 * 60,
		...limits,
	};
	let nextId = 0;

	const fail = (method: keyof BookUploads) => {
		calls.push(method);
		const error = failures[method]?.shift();
		if (error) throw error;
	};
	const find = (id: string) => {
		const upload = staged.get(id);
		if (!upload)
			throw new UploadError(UploadFailure.notFound, "Upload not found");
		return upload;
	};
	const view = (upload: FakeUpload): StagedUpload => ({
		id: upload.id,
		fileName: upload.fileName,
		size: upload.size,
		receivedBytes: upload.received,
		expiresAt: upload.expiresAt,
		book: upload.ready
			? {
					format: upload.fileName.split(".").pop() ?? "",
					title: `${displayName(upload.fileName)} (read)`,
					authorNames: ["An Author"],
					identifier: null,
					publisher: null,
					language: "en",
					tags: [],
					publicationDate: null,
					coverUrl: withCovers ? `/api/uploads/${upload.id}/cover` : null,
				}
			: null,
	});
	const expiry = (hours: number) =>
		new Date(now().getTime() + hours * 60 * 60 * 1000).toISOString();

	const uploads: BookUploads = {
		list: async () => {
			fail("list");
			return { limits: fullLimits, uploads: [...staged.values()].map(view) };
		},
		create: async ({ name, size }) => {
			fail("create");
			if (staged.size >= maxUploads)
				throw new UploadError(
					UploadFailure.storageFull,
					"Finish or cancel an upload before starting another",
				);
			const upload: FakeUpload = {
				id: `staged-${++nextId}`,
				fileName: name,
				size,
				received: 0,
				expiresAt: expiry(1),
				ready: false,
			};
			staged.set(upload.id, upload);
			return view(upload);
		},
		status: async (uploadId) => {
			fail("status");
			return view(find(uploadId));
		},
		sendChunk: async ({
			uploadId,
			offset,
			body,
			onProgress,
			onSent,
			signal,
		}) => {
			fail("sendChunk");
			if (signal?.aborted)
				throw new UploadError(UploadFailure.aborted, "Upload stopped");
			const upload = find(uploadId);
			if (offset !== upload.received)
				throw new UploadError(
					UploadFailure.conflict,
					`The next chunk starts at byte ${upload.received}`,
				);
			if (chunkDelay) {
				onProgress?.(Math.floor(body.size / 2));
				await chunkDelay();
				if (signal?.aborted)
					throw new UploadError(UploadFailure.aborted, "Upload stopped");
			}
			onProgress?.(body.size);
			upload.received += body.size;
			if (upload.received === upload.size) {
				onSent?.();
				await readDelay?.();
				upload.ready = true;
				upload.expiresAt = expiry(fullLimits.reviewSeconds / 3600);
			}
			return view(upload);
		},
		coverUrl: (uploadId) =>
			`https://citadel.test/api/uploads/${uploadId}/cover`,
		commit: async (uploadId, book) => {
			fail("commit");
			const upload = find(uploadId);
			if (!upload.ready)
				throw new UploadError(
					UploadFailure.conflict,
					"The upload hasn't finished",
				);
			staged.delete(uploadId);
			committed.push({ uploadId, book });
			return { id: String(committed.length), title: book.title } as LibraryBook;
		},
		cancel: async (uploadId) => {
			fail("cancel");
			staged.delete(uploadId);
		},
	};

	return {
		uploads,
		staged,
		committed,
		calls,
		/** Seeds an upload, e.g. one left from an earlier visit. */
		seed: (fileName: string, size: number, ready: boolean) => {
			const upload: FakeUpload = {
				id: `staged-${++nextId}`,
				fileName,
				size,
				received: ready ? size : Math.floor(size / 2),
				expiresAt: expiry(ready ? 20 : 1),
				ready,
			};
			staged.set(upload.id, upload);
			return upload.id;
		},
		failNext: (method: keyof BookUploads, ...errors: UploadError[]) => {
			failures[method] = [...(failures[method] ?? []), ...errors];
		},
	};
};
