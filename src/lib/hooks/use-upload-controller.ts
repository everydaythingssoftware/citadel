import { useCallback, useEffect, useMemo } from "react";
import { readyItems, summarize, visibleItems } from "@/lib/uploads/queue";
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
	const canUpload = useLibraryStore(
		(state) => state.library?.uploads !== undefined,
	);
	const enabled = libraryState === LibraryState.ready && canUpload;
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

	const items = useMemo(() => visibleItems(queue), [queue]);
	const ready = useMemo(() => readyItems(queue), [queue]);
	const summary = useMemo(() => summarize(queue), [queue]);
	// Stays true while the sheet closes over the last book; reopening resets it.
	const reviewing = reviewKey !== null;
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
			open: sheetOpen,
			onOpenChange: (open: boolean) =>
				open
					? useUploadsStore.getState().openSheet()
					: useUploadsStore.getState().closeSheet(),
			items,
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
			onAddAll: () => void addAll(),
			onCancelAll: () => {
				for (const item of items)
					void useUploadsStore.getState().remove(item.key);
				useUploadsStore.getState().closeSheet();
			},
		},
	};
};
