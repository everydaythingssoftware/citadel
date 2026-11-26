import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isLocalImports } from "@/lib/services/library";
import {
	isActive,
	isBatchRead,
	type QueueItem,
	readQueue,
	readyItems,
	summarize,
	undecidedDuplicates,
	visibleItems,
} from "@/lib/uploads/queue";
import {
	LibraryState,
	useAuthors,
	useLibraryActions,
	useLibraryState,
	useLibraryStore,
	useTags,
} from "@/stores/library/store";
import { useUploadsStore } from "@/stores/uploads/store";
import { useBookUploads } from "./use-book-uploads";
import { useChooseBookFiles } from "./use-choose-book-files";
import { useFileDrag } from "./use-file-drag";
import { useReviewDeck } from "./use-review-deck";

/** Reading for longer than this shows its progress. */
const SLOW_READ_MS = 300;

/**
 * After a book is added or skipped: the sheet closes once nothing is left at
 * all, or goes back to the queue once nothing is left to review. Either is
 * the one motion: the last book's cover stays put rather than leaving too.
 */
const settleAfterReview = () => {
	const store = useUploadsStore.getState();
	if (visibleItems(store.queue).length === 0) store.closeSheet();
	else if (readyItems(store.queue).length === 0) store.review(null);
};

/**
 * Everything the upload overlay, sheet and toolbar status need: the queue,
 * dropping and choosing files, and review paging.
 */
export const useUploadController = () => {
	useBookUploads();
	const libraryState = useLibraryState();
	const intake = useLibraryStore((state) => state.library?.uploads);
	const enabled = libraryState === LibraryState.ready && intake !== undefined;
	const local = intake !== undefined && isLocalImports(intake);
	const queue = useUploadsStore((state) => state.queue);
	const sheetOpen = useUploadsStore((state) => state.sheetOpen);
	const reviewKey = useUploadsStore((state) => state.reviewKey);
	const authors = useAuthors();
	const tags = useTags();
	const libraryActions = useLibraryActions();
	const chooseFiles = useChooseBookFiles();

	const dragging = useFileDrag({
		enabled,
		onDrop: (files) => useUploadsStore.getState().addFiles(files),
	});

	const read = useMemo(() => readQueue(queue), [queue]);
	const items = useMemo(() => visibleItems(read), [read]);
	const ready = useMemo(() => readyItems(queue), [queue]);
	const summary = useMemo(() => summarize(queue), [queue]);
	// Stays true while the sheet closes over the last book; reopening resets it.
	const reviewing = reviewKey !== null;
	const unread = queue.items.filter((item) => item.unread);
	const reading = unread.length > 0;
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		if (!reading) return;
		const timer = setTimeout(() => setSlow(true), SLOW_READ_MS);
		return () => {
			clearTimeout(timer);
			setSlow(false);
		};
	}, [reading]);
	const undecided = useMemo(() => undecidedDuplicates(read), [read]);
	// Once the step shows, files dropped meanwhile don't take it away.
	const asking = useRef(false);
	asking.current =
		!reviewing && undecided.length > 0 && (asking.current || isBatchRead(read));
	const deck = useReviewDeck({
		ready,
		reviewKey,
		setReviewKey: (key) => useUploadsStore.getState().review(key),
		onAdd: async (key, book) => {
			const added = await useUploadsStore.getState().add(key, book);
			if (added) settleAfterReview();
			return added;
		},
		onSkip: async (key) => {
			await useUploadsStore.getState().remove(key);
			settleAfterReview();
		},
		keyboard: sheetOpen && reviewing,
	});

	// Nothing left to review and nothing leaving (an upload expired, say):
	// back to the queue. A closed sheet keeps its last view while it leaves.
	useEffect(() => {
		if (sheetOpen && reviewing && ready.length === 0 && !deck.departing)
			useUploadsStore.getState().review(null);
	}, [sheetOpen, reviewing, ready.length, deck.departing]);

	// Tag suggestions load on demand, the first time a review needs them.
	useEffect(() => {
		if (reviewing && tags === null) void libraryActions.loadTags();
	}, [reviewing, tags, libraryActions]);

	const addAll = useCallback(async () => {
		const count = readyItems(useUploadsStore.getState().queue).length;
		await useUploadsStore.getState().addAllReady();
		const added = count - readyItems(useUploadsStore.getState().queue).length;
		if (added > 0) settleAfterReview();
	}, []);

	return {
		enabled,
		dragging,
		sheet: {
			local,
			open: sheetOpen,
			onOpenChange: (open: boolean) =>
				open
					? useUploadsStore.getState().openSheet()
					: useUploadsStore.getState().dismissSheet(),
			items,
			reading: reading
				? {
						done: unread.filter((item) => !isActive(item)).length,
						total: unread.length,
						slow,
					}
				: undefined,
			duplicates: asking.current ? undecided : [],
			summary,
			paused: queue.paused,
			reviewing,
			deck,
			authorSuggestions: authors.map((author) => author.name),
			tagSuggestions: (tags ?? []).map((tag) => tag.name),
			onChooseFiles: chooseFiles,
			onReview: (key: string) => useUploadsStore.getState().review(key),
			onBackToQueue: () => useUploadsStore.getState().review(null),
			onRetry: (key: string) => useUploadsStore.getState().retry(key),
			onRemove: (key: string) => void useUploadsStore.getState().remove(key),
			onSkipDuplicates: (duplicates: QueueItem[]) => {
				for (const item of duplicates)
					void useUploadsStore.getState().remove(item.key);
				settleAfterReview();
			},
			onAddDuplicates: (duplicates: QueueItem[]) => {
				for (const item of duplicates)
					useUploadsStore
						.getState()
						.dispatch({ type: "accepted", key: item.key });
			},
			onAddAll: () => void addAll(),
			onCancelAll: () => useUploadsStore.getState().cancelAll(),
		},
	};
};
