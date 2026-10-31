import type {
	ReviewedBook,
	StagedBook,
	StagedUpload,
	UploadLimits,
} from "@/lib/services/library";

/** Formats the server accepts, by extension. */
export const BOOK_EXTENSIONS = ["epub", "mobi", "azw", "azw3", "pdf", "txt"];

export const UploadPhase = {
	/** Queued; nothing sent yet (or retrying after a failure). */
	waiting: "waiting",
	uploading: "uploading",
	/** Every byte sent; the server is reading the file. */
	reading: "reading",
	/** Read and waiting for the user to add or skip it. */
	ready: "ready",
	adding: "adding",
	added: "added",
	/** Stopped part-way; can be retried. */
	failed: "failed",
	/** Never uploaded: too large or not a book. */
	rejected: "rejected",
} as const;
export type TUploadPhase = (typeof UploadPhase)[keyof typeof UploadPhase];

export interface QueueItem {
	/** Local key, stable from the moment a file is added. */
	key: string;
	/** The file's name without its extension, until the book has a title. */
	name: string;
	fileName: string;
	size: number;
	/** The picked file; absent for an upload restored from the server. */
	file?: File;
	uploadId?: string;
	phase: TUploadPhase;
	/** Bytes the server has, plus those in flight for the current chunk. */
	sentBytes: number;
	book?: StagedBook;
	coverUrl?: string;
	expiresAt?: string;
	/** Why the item failed, was rejected, or couldn't be added. */
	message?: string;
}

export interface QueueState {
	items: QueueItem[];
	limits?: UploadLimits;
	/** Set when the server has no room for another upload yet. */
	paused?: string;
}

export const emptyQueue: QueueState = { items: [] };

export type QueueAction =
	| { type: "limits"; limits: UploadLimits }
	| { type: "filesAdded"; items: QueueItem[] }
	| {
			type: "restored";
			uploads: StagedUpload[];
			coverUrl: (id: string) => string;
	  }
	| { type: "started"; key: string; upload: StagedUpload }
	| { type: "progressed"; key: string; sentBytes: number }
	| { type: "sent"; key: string }
	| {
			type: "received";
			key: string;
			upload: StagedUpload;
			coverUrl: (id: string) => string;
	  }
	| {
			type: "failed";
			key: string;
			message: string;
			/** The server no longer has the upload; a retry starts afresh. */
			forget?: boolean;
	  }
	| { type: "rejected"; key: string; message: string }
	| { type: "retried"; key: string }
	| { type: "paused"; key: string; message: string }
	| { type: "resumed" }
	| { type: "adding"; key: string }
	| { type: "added"; key: string }
	| { type: "addFailed"; key: string; message: string }
	| { type: "removed"; key: string }
	| { type: "cleared" };

const extensionOf = (fileName: string): string =>
	fileName.includes(".") ? (fileName.split(".").pop() ?? "").toLowerCase() : "";

/** The name people see: the file's name without its extension. */
export const displayName = (fileName: string): string => {
	const dot = fileName.lastIndexOf(".");
	return dot > 0 ? fileName.slice(0, dot) : fileName;
};

export const RejectReason = {
	tooLarge: "This file is too large to add",
	notABook: "This isn't a book Citadel can add",
	empty: "This file is empty",
} as const;

/** Why a file can't be uploaded at all, checked before any request. */
export const rejectionFor = (
	file: { name: string; size: number },
	limits: UploadLimits | undefined,
): string | undefined => {
	if (!BOOK_EXTENSIONS.includes(extensionOf(file.name)))
		return RejectReason.notABook;
	if (file.size === 0) return RejectReason.empty;
	if (limits && file.size > limits.maxFileBytes) return RejectReason.tooLarge;
	return undefined;
};

let nextKey = 0;
export const queueKey = (): string => `upload-${++nextKey}`;

/** Queue items for picked or dropped files, rejecting the ones that can't go. */
export const itemsForFiles = (
	files: readonly File[],
	limits: UploadLimits | undefined,
	key: () => string = queueKey,
): QueueItem[] =>
	files.map((file) => {
		const message = rejectionFor(file, limits);
		return {
			key: key(),
			name: displayName(file.name),
			fileName: file.name,
			size: file.size,
			file,
			phase: message ? UploadPhase.rejected : UploadPhase.waiting,
			sentBytes: 0,
			message,
		};
	});

const fromStaged = (
	item: QueueItem,
	upload: StagedUpload,
	coverUrl: (id: string) => string,
): QueueItem => ({
	...item,
	uploadId: upload.id,
	expiresAt: upload.expiresAt,
	sentBytes: upload.receivedBytes,
	book: upload.book ?? undefined,
	name: upload.book?.title || item.name,
	coverUrl: upload.book?.coverUrl ? coverUrl(upload.id) : undefined,
	phase: upload.book ? UploadPhase.ready : item.phase,
	message: undefined,
});

const update = (
	state: QueueState,
	key: string,
	change: (item: QueueItem) => QueueItem,
): QueueState => ({
	...state,
	items: state.items.map((item) => (item.key === key ? change(item) : item)),
});

export const queueReducer = (
	state: QueueState,
	action: QueueAction,
): QueueState => {
	switch (action.type) {
		case "limits":
			return { ...state, limits: action.limits };
		case "filesAdded":
			return { ...state, items: [...state.items, ...action.items] };
		case "restored": {
			const known = new Set(state.items.map((item) => item.uploadId));
			const restored = action.uploads
				.filter((upload) => upload.book && !known.has(upload.id))
				.map((upload) =>
					fromStaged(
						{
							key: queueKey(),
							name: displayName(upload.fileName),
							fileName: upload.fileName,
							size: upload.size,
							phase: UploadPhase.ready,
							sentBytes: upload.size,
						},
						upload,
						action.coverUrl,
					),
				);
			return { ...state, items: [...restored, ...state.items] };
		}
		case "started":
			return update(state, action.key, (item) => ({
				...item,
				phase: UploadPhase.uploading,
				uploadId: action.upload.id,
				expiresAt: action.upload.expiresAt,
				sentBytes: action.upload.receivedBytes,
				message: undefined,
			}));
		case "progressed":
			return update(state, action.key, (item) =>
				item.phase === UploadPhase.uploading
					? {
							...item,
							sentBytes: Math.max(
								item.sentBytes,
								Math.min(item.size, action.sentBytes),
							),
						}
					: item,
			);
		case "sent":
			return update(state, action.key, (item) =>
				item.phase === UploadPhase.uploading
					? { ...item, phase: UploadPhase.reading, sentBytes: item.size }
					: item,
			);
		case "received":
			return update(state, action.key, (item) =>
				fromStaged(
					{
						...item,
						phase: action.upload.book ? item.phase : UploadPhase.uploading,
					},
					action.upload,
					action.coverUrl,
				),
			);
		case "failed":
			return update(state, action.key, (item) => ({
				...item,
				phase: UploadPhase.failed,
				message: action.message,
				...(action.forget ? { uploadId: undefined, sentBytes: 0 } : {}),
			}));
		case "rejected":
			return update(state, action.key, (item) => ({
				...item,
				phase: UploadPhase.rejected,
				message: action.message,
				uploadId: undefined,
				sentBytes: 0,
			}));
		case "retried":
			return update(state, action.key, (item) =>
				item.phase === UploadPhase.failed && item.file
					? { ...item, phase: UploadPhase.waiting, message: undefined }
					: item,
			);
		case "paused":
			return {
				...update(state, action.key, (item) => ({
					...item,
					phase: UploadPhase.waiting,
				})),
				paused: action.message,
			};
		case "resumed":
			return { ...state, paused: undefined };
		case "adding":
			return update(state, action.key, (item) => ({
				...item,
				phase: UploadPhase.adding,
				message: undefined,
			}));
		case "added":
			return update(state, action.key, (item) => ({
				...item,
				phase: UploadPhase.added,
			}));
		case "addFailed":
			return update(state, action.key, (item) => ({
				...item,
				phase: UploadPhase.ready,
				message: action.message,
			}));
		case "removed":
			return {
				...state,
				items: state.items.filter((item) => item.key !== action.key),
			};
		case "cleared":
			return { ...state, items: [], paused: undefined };
	}
};

/* --- Selectors --- */

export const isActive = (item: QueueItem): boolean =>
	item.phase === UploadPhase.waiting ||
	item.phase === UploadPhase.uploading ||
	item.phase === UploadPhase.reading;

/** The next file to send: one at a time, and only while there's room. */
export const nextToUpload = (state: QueueState): QueueItem | undefined =>
	state.paused ||
	state.items.some((item) => item.phase === UploadPhase.uploading)
		? undefined
		: state.items.find(
				(item) => item.phase === UploadPhase.waiting && item.file,
			);

export const readyItems = (state: QueueState): QueueItem[] =>
	state.items.filter(
		(item) =>
			item.phase === UploadPhase.ready || item.phase === UploadPhase.adding,
	);

/** Items still shown in the queue: added books leave once acknowledged. */
export const visibleItems = (state: QueueState): QueueItem[] =>
	state.items.filter((item) => item.phase !== UploadPhase.added);

export interface QueueSummary {
	/** Files still being sent or read. */
	active: number;
	ready: number;
	/** 0–1 across everything still being sent. */
	progress: number;
	/** Every queued file has been sent and read. */
	settled: boolean;
}

export const summarize = (state: QueueState): QueueSummary => {
	const active = state.items.filter(isActive);
	const total = active.reduce((sum, item) => sum + item.size, 0);
	const sent = active.reduce((sum, item) => sum + item.sentBytes, 0);
	return {
		active: active.length,
		ready: readyItems(state).length,
		progress: total === 0 ? 1 : sent / total,
		settled: active.length === 0,
	};
};

/** The metadata a ready book is added with when nobody edited it. */
export const reviewedFromStaged = (book: StagedBook): ReviewedBook => ({
	title: book.title,
	authorNames: book.authorNames,
	identifier: book.identifier ?? null,
	publisher: book.publisher ?? null,
	language: book.language ?? null,
	tags: book.tags,
	publicationDate: book.publicationDate ?? null,
});

/** Whether bytes are on their way, so leaving the page would lose them. */
export const isSending = (state: QueueState): boolean =>
	state.items.some(
		(item) =>
			item.phase === UploadPhase.uploading ||
			(item.phase === UploadPhase.waiting && item.file !== undefined),
	);
