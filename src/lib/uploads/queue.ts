import type { LocalFile } from "@/lib/platform";
import type {
	BookMatch,
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
	/** Every byte sent and the server is reading the file, or the desktop is. */
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
	/** The file on this computer, for a book added on the desktop. */
	path?: string;
	uploadId?: string;
	phase: TUploadPhase;
	/** Bytes the server has, plus those in flight for the current chunk. */
	sentBytes: number;
	book?: StagedBook;
	coverUrl?: string;
	expiresAt?: string;
	/** Why the item failed, was rejected, or couldn't be added. */
	message?: string;
	/** Books already in the library that this one may duplicate. */
	matches?: BookMatch[];
	/** Split off: never grouped with another file as one book. */
	separate?: boolean;
}

export interface QueueState {
	items: QueueItem[];
	limits?: UploadLimits;
	/** Set when the server has no room for another upload yet. */
	paused?: string;
	/**
	 * Books chosen again while already waiting: the queue points them out
	 * instead of adding them twice. `id` changes each time, so pointing
	 * out the same book again replays it.
	 */
	noticed?: { keys: string[]; id: number };
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
	/** A file on this computer is being read where it is. */
	| { type: "reading"; key: string }
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
	/** Points out books chosen again while already waiting; none clears it. */
	| { type: "noticed"; keys: string[] }
	/** The files of one book go their own ways, each a book of its own. */
	| { type: "split"; keys: string[] }
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

/** A book chosen or dropped: a file in the page, or one on this computer. */
export type BookSource = File | LocalFile;

const isLocal = (source: BookSource): source is LocalFile =>
	"path" in source && typeof source.path === "string";

/**
 * Why a file can't be uploaded at all, checked before any request. A file
 * on this computer has no size yet; reading it checks the rest.
 */
export const rejectionFor = (
	file: { name: string; size?: number },
	limits: UploadLimits | undefined,
): string | undefined => {
	if (!BOOK_EXTENSIONS.includes(extensionOf(file.name)))
		return RejectReason.notABook;
	if (file.size === undefined) return undefined;
	if (file.size === 0) return RejectReason.empty;
	if (limits && file.size > limits.maxFileBytes) return RejectReason.tooLarge;
	return undefined;
};

let nextKey = 0;
const queueKey = (): string => `upload-${++nextKey}`;

/** Queue items for picked or dropped files, rejecting the ones that can't go. */
export const itemsForFiles = (
	files: readonly BookSource[],
	limits: UploadLimits | undefined,
	key: () => string = queueKey,
): QueueItem[] =>
	files.map((source) => {
		const local = isLocal(source);
		const message = rejectionFor(
			{ name: source.name, size: local ? undefined : source.size },
			limits,
		);
		return {
			key: key(),
			name: displayName(source.name),
			fileName: source.name,
			size: local ? 0 : source.size,
			...(local ? { path: source.path } : { file: source }),
			phase: message ? UploadPhase.rejected : UploadPhase.waiting,
			sentBytes: 0,
			message,
		};
	});

/**
 * The queue item already holding a chosen file, if any: the same file on
 * this computer, or a picked file of the same name and size. Files that
 * failed or were turned away don't count; choosing them again retries.
 */
export const alreadyQueued = (
	state: QueueState,
	source: BookSource,
): QueueItem | undefined =>
	state.items.find(
		(item) =>
			item.phase !== UploadPhase.added &&
			item.phase !== UploadPhase.rejected &&
			item.phase !== UploadPhase.failed &&
			(isLocal(source)
				? item.path === source.path
				: item.file !== undefined
					? item.file.name === source.name && item.file.size === source.size
					: item.fileName === source.name && item.size === source.size),
	);

/** Whether the item still has its file, to send or read (again). */
export const hasSource = (item: QueueItem): boolean =>
	item.file !== undefined || item.path !== undefined;

const fromStaged = (
	item: QueueItem,
	upload: StagedUpload,
	coverUrl: (id: string) => string,
): QueueItem => ({
	...item,
	uploadId: upload.id,
	expiresAt: upload.expiresAt,
	size: upload.size,
	sentBytes: upload.receivedBytes,
	book: upload.book ?? undefined,
	name: upload.book?.title || item.name,
	coverUrl: upload.book?.coverUrl ? coverUrl(upload.id) : undefined,
	phase: upload.book ? UploadPhase.ready : item.phase,
	message: undefined,
	matches: upload.matches ?? [],
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
		case "reading":
			return update(state, action.key, (item) =>
				item.phase === UploadPhase.waiting
					? { ...item, phase: UploadPhase.reading, message: undefined }
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
				item.phase === UploadPhase.failed && hasSource(item)
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
		case "split":
			return {
				...state,
				items: state.items.map((item) =>
					action.keys.includes(item.key) ? { ...item, separate: true } : item,
				),
			};
		case "noticed":
			return action.keys.length === 0
				? { ...state, noticed: undefined }
				: {
						...state,
						noticed: { keys: action.keys, id: (state.noticed?.id ?? 0) + 1 },
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
				(item) => item.phase === UploadPhase.waiting && hasSource(item),
			);

export const readyItems = (state: QueueState): QueueItem[] =>
	state.items.filter(
		(item) =>
			item.phase === UploadPhase.ready || item.phase === UploadPhase.adding,
	);

/**
 * One book in the queue: usually one file, but an EPUB and a MOBI of the
 * same book (same ISBN, or same title and authors) read as one book with two
 * formats, added together.
 */
export interface BookRow {
	/** The lead file's key, which names the row. */
	key: string;
	/** The file whose metadata and cover the book shows. */
	lead: QueueItem;
	items: QueueItem[];
	/** Books already in the library this one may duplicate, strongest first. */
	matches: BookMatch[];
}

const isReadyItem = (item: QueueItem): boolean =>
	item.phase === UploadPhase.ready || item.phase === UploadPhase.adding;

const sameBook = (a: StagedBook, b: StagedBook): boolean =>
	(a.matchKeys.isbn != null && a.matchKeys.isbn === b.matchKeys.isbn) ||
	(a.matchKeys.titleAuthors != null &&
		a.matchKeys.titleAuthors === b.matchKeys.titleAuthors);

const groupable = (item: QueueItem): item is QueueItem & { book: StagedBook } =>
	item.book !== undefined && !item.separate && isReadyItem(item);

/** Another format of the same book as every file already in the group. */
const joins = (group: QueueItem[], item: QueueItem): boolean =>
	groupable(item) &&
	group.every(
		(other) =>
			groupable(other) &&
			other.book.format !== item.book.format &&
			sameBook(other.book, item.book),
	);

const mergedMatches = (items: QueueItem[]): BookMatch[] => [
	...new Map(
		items
			.flatMap((item) => item.matches ?? [])
			.map((match) => [match.id, match]),
	).values(),
];

/** Whose metadata and cover a book of several files shows: the richest format. */
const LEAD_FORMATS = ["epub", "azw3", "mobi", "azw", "pdf", "txt"];
const leadRank = (item: QueueItem): number => {
	const rank = LEAD_FORMATS.indexOf(item.book?.format ?? "");
	return rank === -1 ? LEAD_FORMATS.length : rank;
};

/** The queue as books, in the order their first file arrived. */
export const bookRows = (state: QueueState): BookRow[] =>
	visibleItems(state)
		.reduce<{ lead: QueueItem; items: QueueItem[] }[]>((rows, item) => {
			const row = rows.find((candidate) => joins(candidate.items, item));
			if (row) row.items.push(item);
			else rows.push({ lead: item, items: [item] });
			return rows;
		}, [])
		.map(({ lead: first, items }) => {
			const lead = items.reduce(
				(best, item) => (leadRank(item) < leadRank(best) ? item : best),
				first,
			);
			return {
				key: lead.key,
				lead,
				items: [lead, ...items.filter((item) => item !== lead)],
				matches: mergedMatches(items),
			};
		});

export const isPossibleDuplicate = (row: BookRow): boolean =>
	row.matches.length > 0 && isReadyItem(row.lead);

/** The formats a row's files make up, as people know them ("EPUB"). */
export const rowFormats = (row: BookRow): string[] =>
	row.items.flatMap((item) =>
		item.book ? [item.book.format.toUpperCase()] : [],
	);

/** A file a book is made of, as the review lists it. */
export interface BookFile {
	key: string;
	/** As people know it: "EPUB". */
	format: string;
	fileName: string;
}

/** The files a row's book is made of, lead first. */
export const rowFiles = (row: BookRow): BookFile[] =>
	row.items.flatMap((item) =>
		item.book
			? [
					{
						key: item.key,
						format: item.book.format.toUpperCase(),
						fileName: item.fileName,
					},
				]
			: [],
	);

export interface QueueSections {
	/** New books, and files still on their way. */
	books: BookRow[];
	/** Ready books that may already be in the library. */
	possibleDuplicates: BookRow[];
}

export const queueSections = (state: QueueState): QueueSections => {
	const rows = bookRows(state);
	return {
		books: rows.filter((row) => !isPossibleDuplicate(row)),
		possibleDuplicates: rows.filter(isPossibleDuplicate),
	};
};

/** The books to review, in the order the queue lists them. */
export const reviewRows = (state: QueueState): BookRow[] => {
	const { books, possibleDuplicates } = queueSections(state);
	return [...books, ...possibleDuplicates].filter((row) =>
		isReadyItem(row.lead),
	);
};

/** Ready books Add New Books takes: everything that isn't a possible duplicate. */
export const newReadyRows = (state: QueueState): BookRow[] =>
	queueSections(state).books.filter(
		(row) => row.lead.phase === UploadPhase.ready && row.lead.book,
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
}

export const summarize = (state: QueueState): QueueSummary => {
	const active = state.items.filter(isActive);
	const total = active.reduce((sum, item) => sum + item.size, 0);
	const sent = active.reduce((sum, item) => sum + item.sentBytes, 0);
	return {
		active: active.length,
		ready: readyItems(state).length,
		progress: total === 0 ? 1 : sent / total,
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
