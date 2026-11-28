import { useEffect, useRef, useState } from "react";

/** Work that finishes sooner than this never shows that it was happening. */
export const SHOW_PENDING_AFTER_MS = 300;
/** Once shown, a pending state stays at least this long, so it never flickers. */
export const SHOW_PENDING_AT_LEAST_MS = 600;

interface Seen {
	/** When the item was first seen pending. */
	since: number;
	/** When its pending state was first shown. */
	shownAt?: number;
	/** The item as last shown pending, held while its minimum runs. */
	shown?: unknown;
}

/**
 * Loading that is either instant or visible long enough to read. An item
 * that is pending (being read or sent) is held back for its first
 * {@link SHOW_PENDING_AFTER_MS}, so quick work goes straight to its result;
 * once its pending state shows, it shows for at least
 * {@link SHOW_PENDING_AT_LEAST_MS}, so it never flashes for a few frames.
 */
export const usePendingGrace = <TItem extends { key: string }>(
	items: readonly TItem[],
	isPending: (item: TItem) => boolean,
	now: () => number = () => performance.now(),
): TItem[] => {
	const seen = useRef(new Map<string, Seen>());
	const [, setTick] = useState(0);
	const wake = useRef<number | undefined>(undefined);
	const time = now();
	let next = Number.POSITIVE_INFINITY;

	const shown = items.flatMap((item) => {
		const entry = seen.current.get(item.key);
		if (isPending(item)) {
			const since = entry?.since ?? time;
			if (time - since < SHOW_PENDING_AFTER_MS) {
				seen.current.set(item.key, { since });
				next = Math.min(next, since + SHOW_PENDING_AFTER_MS);
				return [];
			}
			seen.current.set(item.key, {
				since,
				shownAt: entry?.shownAt ?? time,
				shown: item,
			});
			return [item];
		}
		if (entry?.shownAt !== undefined) {
			const until = entry.shownAt + SHOW_PENDING_AT_LEAST_MS;
			if (time < until) {
				next = Math.min(next, until);
				return [entry.shown as TItem];
			}
		}
		seen.current.delete(item.key);
		return [item];
	});

	// Forget items that left.
	const keys = new Set(items.map((item) => item.key));
	for (const key of seen.current.keys())
		if (!keys.has(key)) seen.current.delete(key);

	useEffect(() => {
		if (next === Number.POSITIVE_INFINITY) return;
		window.clearTimeout(wake.current);
		wake.current = window.setTimeout(
			() => setTick((tick) => tick + 1),
			Math.max(0, next - now()),
		);
		return () => window.clearTimeout(wake.current);
	});

	return shown;
};
