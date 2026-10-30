import type {
	BookUploads,
	ReviewedBook,
	StagedUpload,
} from "@/lib/services/library";
import { UploadError, UploadFailure } from "@/lib/services/library";
import {
	itemsForFiles,
	nextToUpload,
	type QueueAction,
	type QueueItem,
	type QueueState,
	readyItems,
	reviewedFromStaged,
} from "./queue";

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** Attempts per chunk after a dropped connection or server error. */
const MAX_RETRIES = 3;
const CANCEL_ATTEMPTS = 5;
export const PAUSED_MESSAGE = "Add or skip some books to keep uploading.";

export interface UploadRunnerDeps {
	uploads: BookUploads;
	getState: () => QueueState;
	dispatch: (action: QueueAction) => void;
	/** Called after a book lands in the library. */
	onBookAdded?: () => void;
	sleep?: (ms: number) => Promise<void>;
}

export interface UploadRunner {
	/** Loads the limits and any finished uploads from an earlier visit. */
	restore(): Promise<void>;
	addFiles(files: readonly File[]): void;
	retry(key: string): void;
	/** Stops and discards an upload (or skips a ready book). */
	remove(key: string): Promise<void>;
	/** Adds a ready book with the reviewed metadata; true when it landed. */
	add(key: string, book: ReviewedBook): Promise<boolean>;
	/** Adds every ready book with the metadata read from its file. */
	addAllReady(): Promise<void>;
	/** Stops in-flight transfers; staged uploads stay on the server. */
	dispose(): void;
}

const messageFor = (error: unknown): string => {
	if (!(error instanceof UploadError))
		return error instanceof Error ? error.message : "Something went wrong";
	switch (error.failure) {
		case UploadFailure.network:
		case UploadFailure.server:
			return "The connection dropped. Try again when you're back online.";
		case UploadFailure.unauthorized:
			return "You've been signed out. Sign in again, then try again.";
		case UploadFailure.notFound:
			return "This upload expired. Try again to start over.";
		case UploadFailure.readOnly:
			return "This library can't take new books right now.";
		default:
			return error.message;
	}
};

const failureOf = (error: unknown) =>
	error instanceof UploadError ? error.failure : undefined;

const retryable = (error: unknown) => {
	const failure = failureOf(error);
	return failure === UploadFailure.network || failure === UploadFailure.server;
};

/**
 * Drives the queue: sends one file at a time in chunks, resuming from the
 * server's offset after a failure, and starts the next file as soon as the
 * previous one's last byte has left (while the server reads it).
 */
export const createUploadRunner = ({
	uploads,
	getState,
	dispatch,
	onBookAdded,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: UploadRunnerDeps): UploadRunner => {
	const controllers = new Map<string, AbortController>();
	let pumping = false;
	let disposed = false;

	const current = (key: string): QueueItem | undefined =>
		getState().items.find((item) => item.key === key);

	const coverUrl = (id: string) => uploads.coverUrl(id);

	/** Sends one file; resolves `sent` once its last byte leaves the browser. */
	const transfer = async (item: QueueItem, sent: () => void): Promise<void> => {
		const file = item.file;
		if (!file) return sent();
		const controller = new AbortController();
		controllers.set(item.key, controller);
		const stillWanted = () => !controller.signal.aborted && current(item.key) !== undefined;
		const chunkBytes = getState().limits?.chunkBytes ?? DEFAULT_CHUNK_BYTES;
		let attempts = 0;
		let upload: StagedUpload;

		/** Handles a failure: the upload to carry on from, or undefined to stop. */
		const recover = async (error: unknown): Promise<StagedUpload | undefined> => {
			if (!stillWanted() || failureOf(error) === UploadFailure.aborted) return undefined;
			const failure = failureOf(error);
			if (failure === UploadFailure.storageFull && !item.uploadId) {
				dispatch({ type: "paused", key: item.key, message: PAUSED_MESSAGE });
				return undefined;
			}
			if (failure === UploadFailure.invalid || failure === UploadFailure.tooLarge) {
				dispatch({ type: "rejected", key: item.key, message: messageFor(error) });
				return undefined;
			}
			if ((retryable(error) || failure === UploadFailure.conflict) && attempts < MAX_RETRIES) {
				attempts += 1;
				if (failure !== UploadFailure.conflict) await sleep(1000 * 2 ** (attempts - 1));
				const uploadId = current(item.key)?.uploadId;
				if (!stillWanted() || !uploadId) return undefined;
				try {
					return await uploads.status(uploadId);
				} catch (statusError) {
					return recover(statusError);
				}
			}
			dispatch({
				type: "failed",
				key: item.key,
				message: messageFor(error),
				forget: failure === UploadFailure.notFound,
			});
			return undefined;
		};

		try {
			try {
				upload = item.uploadId
					? await uploads.status(item.uploadId)
					: await uploads.create({ name: item.fileName, size: item.size });
			} catch (error) {
				const recovered = await recover(error);
				if (!recovered) return;
				upload = recovered;
			}
			if (!stillWanted()) return;
			dispatch({ type: "started", key: item.key, upload });
			dispatch({ type: "received", key: item.key, upload, coverUrl });

			while (!upload.book) {
				const offset = upload.receivedBytes;
				const end = Math.min(item.size, offset + chunkBytes);
				const last = end === item.size;
				try {
					upload = await uploads.sendChunk({
						uploadId: upload.id,
						offset,
						body: file.slice(offset, end),
						signal: controller.signal,
						onProgress: (bytes) =>
							dispatch({ type: "progressed", key: item.key, sentBytes: offset + bytes }),
						onSent: last
							? () => {
									dispatch({ type: "sent", key: item.key });
									sent();
								}
							: undefined,
					});
					attempts = 0;
				} catch (error) {
					const recovered = await recover(error);
					if (!recovered) return;
					upload = recovered;
				}
				if (!stillWanted()) return;
				dispatch({ type: "received", key: item.key, upload, coverUrl });
				if (!upload.book && upload.receivedBytes >= item.size) {
					dispatch({
						type: "failed",
						key: item.key,
						message: "The server couldn't read this file.",
					});
					return;
				}
			}
		} finally {
			controllers.delete(item.key);
			sent();
		}
	};

	const pump = async () => {
		if (pumping || disposed) return;
		pumping = true;
		try {
			for (;;) {
				const item = nextToUpload(getState());
				if (!item || disposed) break;
				await new Promise<void>((resolve) => {
					void transfer(item, resolve);
				});
			}
		} finally {
			pumping = false;
		}
	};

	/** Lets a paused queue carry on once a slot frees up. */
	const freed = () => {
		if (getState().paused) dispatch({ type: "resumed" });
		void pump();
	};

	const cancelOnServer = async (uploadId: string) => {
		for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
			try {
				await uploads.cancel(uploadId);
				return;
			} catch (error) {
				// Busy while an aborted chunk winds down; anything else expires on its own.
				if (failureOf(error) !== UploadFailure.conflict) return;
				await sleep(300);
			}
		}
	};

	const add = async (key: string, book: ReviewedBook): Promise<boolean> => {
		const item = current(key);
		if (!item?.uploadId) return false;
		dispatch({ type: "adding", key });
		try {
			await uploads.commit(item.uploadId, book);
		} catch (error) {
			dispatch({ type: "addFailed", key, message: messageFor(error) });
			return false;
		}
		dispatch({ type: "added", key });
		onBookAdded?.();
		freed();
		return true;
	};

	return {
		restore: async () => {
			try {
				const { limits, uploads: staged } = await uploads.list();
				dispatch({ type: "limits", limits });
				dispatch({ type: "restored", uploads: staged, coverUrl });
				const known = new Set(getState().items.map((item) => item.uploadId));
				// Unfinished uploads from another visit can't continue without
				// their files, so they're discarded to free their slots.
				await Promise.all(
					staged
						.filter((upload) => !upload.book && !known.has(upload.id))
						.map((upload) => cancelOnServer(upload.id)),
				);
			} catch {
				// The queue still works with default limits; uploads show their own errors.
			}
		},
		addFiles: (files) => {
			if (files.length === 0) return;
			dispatch({ type: "filesAdded", items: itemsForFiles(files, getState().limits) });
			void pump();
		},
		retry: (key) => {
			dispatch({ type: "retried", key });
			void pump();
		},
		remove: async (key) => {
			const item = current(key);
			if (!item) return;
			controllers.get(key)?.abort();
			dispatch({ type: "removed", key });
			if (item.uploadId) await cancelOnServer(item.uploadId);
			freed();
		},
		add,
		addAllReady: async () => {
			for (const item of readyItems(getState())) {
				if (item.book && item.phase === "ready") await add(item.key, reviewedFromStaged(item.book));
			}
		},
		dispose: () => {
			disposed = true;
			for (const controller of controllers.values()) controller.abort();
		},
	};
};
