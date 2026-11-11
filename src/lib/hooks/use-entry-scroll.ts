import {
	useElementScrollRestoration,
	useRouterState,
} from "@tanstack/react-router";
import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { TScrollRegion } from "@/lib/navigation";

interface EntryScrollOptions {
	region: TScrollRegion;
	elementRef: RefObject<HTMLElement | null>;
	/** Identifies what the region shows; a new view starts at the top. */
	viewKey: string;
	/** True once the region holds the current view's content. */
	viewReady: boolean;
	/** Changes whenever the region's content (and so its height) does. */
	content: unknown;
}

interface EntryScroll {
	/** Where a virtualized list in the region should start when it mounts. */
	startOffset: number | undefined;
}

/**
 * Keeps a scroll region where its history entry left it. Arriving at an
 * entry — opening the page, or going Back to another view of it — returns
 * the region to its recorded offset (or the top of a new entry) once that
 * entry's content is in; a new view within the same entry starts at the top.
 */
export const useEntryScroll = ({
	region,
	elementRef,
	viewKey,
	viewReady,
	content,
}: EntryScrollOptions): EntryScroll => {
	const entryKey = useRouterState({
		select: (state) => state.location.state.__TSR_key ?? state.location.href,
	});
	const recorded = useElementScrollRestoration({ id: region })?.scrollY;

	const [startOffset] = useState(recorded);
	const pendingRef = useRef<number | null>(recorded ?? null);
	const arrivedAtRef = useRef(entryKey);
	const viewKeyRef = useRef(viewKey);

	useLayoutEffect(() => {
		if (arrivedAtRef.current === entryKey) return;
		arrivedAtRef.current = entryKey;
		pendingRef.current = recorded ?? 0;
	}, [entryKey, recorded]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: content is a trigger — the region's height follows it.
	useLayoutEffect(() => {
		const offset = pendingRef.current;
		if (offset === null || !viewReady || !elementRef.current) return;
		pendingRef.current = null;
		elementRef.current.scrollTop = offset;
	}, [viewReady, content, elementRef]);

	useEffect(() => {
		if (viewKeyRef.current === viewKey) return;
		viewKeyRef.current = viewKey;
		if (pendingRef.current !== null) return;
		if (elementRef.current) elementRef.current.scrollTop = 0;
	}, [viewKey, elementRef]);

	return { startOffset };
};
