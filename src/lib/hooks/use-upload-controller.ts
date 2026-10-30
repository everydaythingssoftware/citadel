import { useCallback, useMemo } from "react";
import { toast } from "@/components/ui";
import { countdown } from "@/lib/uploads/countdown";
import {
	type QueueItem,
	readyItems,
	summarize,
	UploadPhase,
	visibleItems,
} from "@/lib/uploads/queue";
import {
	LibraryState,
	useAuthors,
	useLibraryState,
	useLibraryStore,
} from "@/stores/library/store";
import { useUploadsStore } from "@/stores/uploads/store";
import { useBookUploads } from "./use-book-uploads";
import { useChooseBookFiles } from "./use-choose-book-files";
import { useFileDrag } from "./use-file-drag";
import { useNow } from "./use-now";
import { LEAVE_MS, useReviewDeck } from "./use-review-deck";

/**
 * After a book is added: back to the queue once nothing is left to review,
 * and the sheet closes behind the card's exit once nothing is left at all
 * (unless more books arrived meanwhile).
 */
const settleAfterAdding = () => {
	const store = useUploadsStore.getState();
	if (visibleItems(store.queue).length > 0) {
		if (readyItems(store.queue).length === 0) store.review(null);
		return;
	}
	setTimeout(() => {
		const later = useUploadsStore.getState();
		if (visibleItems(later.queue).length === 0) later.closeSheet();
	}, LEAVE_MS);
};

/**
 * Everything the upload overlay, sheet and toolbar status need: the queue,
 * dropping and choosing files, review paging and the countdown clock.
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
	const now = useNow();
	const chooseFiles = useChooseBookFiles();

	const dragging = useFileDrag({
		enabled,
		onDrop: (files) => useUploadsStore.getState().addFiles(files),
	});

	const items = useMemo(() => visibleItems(queue), [queue]);
	const ready = useMemo(() => readyItems(queue), [queue]);
	const summary = useMemo(() => summarize(queue), [queue]);
	const reviewSeconds = queue.limits?.reviewSeconds ?? 24 * 60 * 60;

	const countdownFor = useCallback(
		(item: QueueItem) =>
			item.phase === UploadPhase.ready && item.expiresAt
				? countdown(item.expiresAt, now, reviewSeconds)
				: undefined,
		[now, reviewSeconds],
	);
	const reviewing = reviewKey !== null && ready.length > 0;
	const deck = useReviewDeck({
		ready,
		reviewKey,
		setReviewKey: (key) => useUploadsStore.getState().review(key),
		onAdd: async (key, book) => {
			const added = await useUploadsStore.getState().add(key, book);
			if (added) {
				toast.show({ title: "Added to Library", message: book.title });
				settleAfterAdding();
			}
			return added;
		},
		onSkip: (key) => useUploadsStore.getState().remove(key),
		keyboard: sheetOpen && reviewing,
	});

	const addAll = useCallback(async () => {
		const count = readyItems(useUploadsStore.getState().queue).length;
		await useUploadsStore.getState().addAllReady();
		const added = count - readyItems(useUploadsStore.getState().queue).length;
		if (added > 0) {
			toast.show({
				title: "Added to Library",
				message: added === 1 ? "1 book" : `${added} books`,
			});
			settleAfterAdding();
		}
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
			countdownFor,
			reviewing,
			deck,
			authorSuggestions: authors.map((author) => author.name),
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
