import { create } from "zustand";
import type { BookUploads, ReviewedBook } from "@/lib/services/library";
import {
	emptyQueue,
	type QueueAction,
	type QueueState,
	queueReducer,
} from "@/lib/uploads/queue";
import { createUploadRunner, type UploadRunner } from "@/lib/uploads/runner";

interface UploadsState {
	queue: QueueState;
	/** The upload sheet is showing (uploads carry on while it's closed). */
	sheetOpen: boolean;
	/** The ready book shown in the review card, when reviewing. */
	reviewKey: string | null;
	runner: UploadRunner | null;
}

interface UploadsActions {
	/**
	 * Points the queue at a library's uploads (or none), restoring finished
	 * uploads from an earlier visit. A different library starts a new queue.
	 */
	connect: (uploads: BookUploads | undefined, onBookAdded: () => void) => void;
	dispatch: (action: QueueAction) => void;
	addFiles: (files: readonly File[]) => void;
	retry: (key: string) => void;
	remove: (key: string) => Promise<void>;
	add: (key: string, book: ReviewedBook) => Promise<boolean>;
	addAllReady: () => Promise<void>;
	openSheet: () => void;
	closeSheet: () => void;
	review: (key: string | null) => void;
}

let connected: BookUploads | undefined;

export const useUploadsStore = create<UploadsState & UploadsActions>()(
	(set, get) => ({
		queue: emptyQueue,
		sheetOpen: false,
		reviewKey: null,
		runner: null,
		connect: (uploads, onBookAdded) => {
			if (uploads === connected) return;
			connected = uploads;
			get().runner?.dispose();
			if (!uploads) {
				set({
					queue: emptyQueue,
					runner: null,
					sheetOpen: false,
					reviewKey: null,
				});
				return;
			}
			const runner = createUploadRunner({
				uploads,
				getState: () => get().queue,
				dispatch: (action) => get().dispatch(action),
				onBookAdded,
			});
			set({ queue: emptyQueue, runner, reviewKey: null });
			void runner.restore();
		},
		dispatch: (action) =>
			set((state) => ({ queue: queueReducer(state.queue, action) })),
		addFiles: (files) => {
			get().runner?.addFiles(files);
			if (files.length === 0) return;
			// Reopening starts from the queue; an open sheet stays where it is.
			set((state) =>
				state.sheetOpen ? state : { sheetOpen: true, reviewKey: null },
			);
		},
		retry: (key) => get().runner?.retry(key),
		remove: async (key) => {
			await get().runner?.remove(key);
		},
		add: async (key, book) => (await get().runner?.add(key, book)) ?? false,
		addAllReady: async () => {
			await get().runner?.addAllReady();
		},
		openSheet: () =>
			set((state) =>
				state.sheetOpen ? state : { sheetOpen: true, reviewKey: null },
			),
		// What was on screen stays while the sheet animates away; the next
		// open starts from the queue.
		closeSheet: () => set({ sheetOpen: false }),
		review: (key) => set({ reviewKey: key }),
	}),
);
