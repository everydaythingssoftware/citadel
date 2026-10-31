import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import type { StagedBook } from "@/lib/services/library";
import { type QueueItem, RejectReason, UploadPhase } from "./queue";
import { formForBook } from "./review";

/** Sample queue content for stories and previews. */
export const sampleBook = (title: string, author: string): StagedBook => ({
	format: "epub",
	title,
	authorNames: [author],
	identifier: null,
	publisher: null,
	language: "en",
	tags: [],
	publicationDate: null,
	coverUrl: null,
});

export const inHours = (hours: number, from = new Date()): string =>
	new Date(from.getTime() + hours * 3_600_000).toISOString();

export const sampleQueue = (now = new Date()): QueueItem[] => [
	{
		key: "1",
		name: "Moby-Dick",
		fileName: "moby-dick.epub",
		size: 10,
		phase: UploadPhase.ready,
		sentBytes: 10,
		uploadId: "a",
		book: sampleBook("Moby-Dick", "Herman Melville"),
		expiresAt: inHours(22, now),
	},
	{
		key: "2",
		name: "Pride and Prejudice",
		fileName: "pride.mobi",
		size: 10,
		phase: UploadPhase.ready,
		sentBytes: 10,
		uploadId: "b",
		book: sampleBook("Pride and Prejudice", "Jane Austen"),
		expiresAt: inHours(3, now),
	},
	{
		key: "3",
		name: "middlemarch",
		fileName: "middlemarch.epub",
		size: 10,
		phase: UploadPhase.reading,
		sentBytes: 10,
	},
	{
		key: "4",
		name: "war-and-peace-illustrated",
		fileName: "war-and-peace-illustrated.pdf",
		size: 100,
		phase: UploadPhase.uploading,
		sentBytes: 62,
	},
	{
		key: "5",
		name: "walden",
		fileName: "walden.azw3",
		size: 10,
		phase: UploadPhase.waiting,
		sentBytes: 0,
		file: new File(["x"], "walden.azw3"),
	},
	{
		key: "6",
		name: "kim",
		fileName: "kim.epub",
		size: 10,
		phase: UploadPhase.failed,
		sentBytes: 4,
		file: new File(["x"], "kim.epub"),
		message: "The connection dropped. Try again when you're back online.",
	},
	{
		key: "7",
		name: "atlas-of-canada",
		fileName: "atlas-of-canada.pdf",
		size: 10,
		phase: UploadPhase.rejected,
		sentBytes: 0,
		message: RejectReason.tooLarge,
	},
	{
		key: "8",
		name: "Emma",
		fileName: "emma.epub",
		size: 10,
		phase: UploadPhase.adding,
		sentBytes: 10,
		book: sampleBook("Emma", "Jane Austen"),
	},
];

/** A review deck frozen on its first ready book, for static stories. */
export const staticDeck = (items: QueueItem[]): ReviewDeck => {
	const ready = items.filter((item) => item.phase === UploadPhase.ready);
	return {
		items: ready,
		current: ready[0],
		index: 0,
		count: ready.length,
		form: formForBook(ready[0]?.book),
		errors: {},
		updateForm: () => {},
		leaveField: () => {},
		detailsOpen: false,
		toggleDetails: () => {},
		departing: undefined,
		leaving: false,
		canPrevious: false,
		canNext: ready.length > 1,
		previous: () => {},
		next: () => {},
		select: () => {},
		add: async () => {},
		skip: async () => {},
	};
};
