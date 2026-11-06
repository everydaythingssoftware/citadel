import { useMemo } from "react";
import { isLocalImports } from "@/lib/services/library";
import { type Countdown, countdown } from "@/lib/uploads/countdown";
import { type QueueSummary, readyItems, summarize } from "@/lib/uploads/queue";
import { useLibraryStore } from "@/stores/library/store";
import { useUploadsStore } from "@/stores/uploads/store";
import { useNow } from "./use-now";

/** The queue at a glance for the toolbar; reads only, no side effects. */
export const useUploadStatus = (): {
	summary: QueueSummary;
	soonest: Countdown | undefined;
	/** Books are read from this computer rather than uploaded. */
	local: boolean;
	open: () => void;
} => {
	const intake = useLibraryStore((state) => state.library?.uploads);
	const queue = useUploadsStore((state) => state.queue);
	const openSheet = useUploadsStore((state) => state.openSheet);
	const now = useNow();
	const summary = useMemo(() => summarize(queue), [queue]);
	const soonest = useMemo(() => {
		const deadlines = readyItems(queue)
			.map((item) => item.expiresAt)
			.filter((expiresAt): expiresAt is string => expiresAt !== undefined)
			.sort();
		const first = deadlines[0];
		return first
			? countdown(first, now, queue.limits?.reviewSeconds ?? 24 * 60 * 60)
			: undefined;
	}, [queue, now]);
	return {
		summary,
		soonest,
		local: intake !== undefined && isLocalImports(intake),
		open: openSheet,
	};
};
