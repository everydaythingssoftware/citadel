import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewedBook } from "@/lib/services/library";
import type { QueueItem } from "@/lib/uploads/queue";
import {
	formForBook,
	type ReviewForm,
	reviewedFromForm,
} from "@/lib/uploads/review";
import { useKeymap } from "./use-keymap";
import { type SwipeHandlers, useSwipe } from "./use-swipe";

export const DeckTransition = {
	forward: "forward",
	back: "back",
	added: "added",
	skipped: "skipped",
} as const;
export type TDeckTransition =
	(typeof DeckTransition)[keyof typeof DeckTransition];

/** How long a card takes to leave; matches the CSS animations. */
export const LEAVE_MS = 420;

export interface LeavingCard {
	item: QueueItem;
	form: ReviewForm;
	transition: TDeckTransition;
}

export interface ReviewDeck {
	current: QueueItem | undefined;
	index: number;
	count: number;
	form: ReviewForm;
	updateForm: (patch: Partial<ReviewForm>) => void;
	/** The card on its way out, while it animates. */
	leaving: LeavingCard | undefined;
	/** How the current card arrived. */
	entered: TDeckTransition | undefined;
	canPrevious: boolean;
	canNext: boolean;
	previous: () => void;
	next: () => void;
	add: () => Promise<void>;
	skip: () => Promise<void>;
	/** Spread on the card area: swipe left for the next book, right for the previous. */
	swipe: SwipeHandlers;
}

/**
 * Pages through ready books one card at a time, keeping each card's edits,
 * and animates cards out as they're added, skipped or paged past.
 */
export const useReviewDeck = ({
	ready,
	reviewKey,
	setReviewKey,
	onAdd,
	onSkip,
	keyboard = true,
}: {
	ready: QueueItem[];
	reviewKey: string | null;
	setReviewKey: (key: string | null) => void;
	onAdd: (key: string, book: ReviewedBook) => Promise<boolean>;
	onSkip: (key: string) => Promise<void>;
	keyboard?: boolean;
}): ReviewDeck => {
	const [drafts, setDrafts] = useState<Record<string, ReviewForm>>({});
	const [leaving, setLeaving] = useState<LeavingCard>();
	const [entered, setEntered] = useState<TDeckTransition>();
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const index = Math.max(
		0,
		ready.findIndex((item) => item.key === reviewKey),
	);
	const current = ready[index];
	const form = useMemo(
		() =>
			current
				? (drafts[current.key] ?? formForBook(current.book))
				: formForBook(undefined),
		[current, drafts],
	);

	useEffect(() => () => clearTimeout(timer.current), []);

	const animate = useCallback(
		(item: QueueItem, itemForm: ReviewForm, transition: TDeckTransition) => {
			clearTimeout(timer.current);
			setLeaving({ item, form: itemForm, transition });
			setEntered(transition);
			timer.current = setTimeout(() => setLeaving(undefined), LEAVE_MS);
		},
		[],
	);

	const go = useCallback(
		(step: 1 | -1) => {
			const target = ready[index + step];
			if (!current || !target) return;
			animate(
				current,
				form,
				step === 1 ? DeckTransition.forward : DeckTransition.back,
			);
			setReviewKey(target.key);
		},
		[ready, index, current, form, animate, setReviewKey],
	);

	/** Moves on from the current card once it's gone: next, else previous. */
	const neighbour = useCallback(
		() => (ready[index + 1] ?? ready[index - 1])?.key ?? null,
		[ready, index],
	);

	const add = useCallback(async () => {
		if (!current) return;
		const key = current.key;
		const after = neighbour();
		if (await onAdd(key, reviewedFromForm(form))) {
			animate(current, form, DeckTransition.added);
			setReviewKey(after);
			setDrafts(({ [key]: _, ...rest }) => rest);
		}
	}, [current, form, neighbour, onAdd, animate, setReviewKey]);

	const skip = useCallback(async () => {
		if (!current) return;
		const key = current.key;
		animate(current, form, DeckTransition.skipped);
		setReviewKey(neighbour());
		setDrafts(({ [key]: _, ...rest }) => rest);
		await onSkip(key);
	}, [current, form, neighbour, onSkip, animate, setReviewKey]);

	useKeymap(
		keyboard
			? [
					{ chord: "arrowleft", onMatch: () => go(-1) },
					{ chord: "arrowright", onMatch: () => go(1) },
				]
			: [],
	);

	const swipe = useSwipe({
		onSwipeLeft: () => go(1),
		onSwipeRight: () => go(-1),
	});

	return {
		current,
		index,
		count: ready.length,
		form,
		updateForm: (patch) => {
			if (!current) return;
			setDrafts((all) => ({ ...all, [current.key]: { ...form, ...patch } }));
		},
		leaving,
		entered,
		canPrevious: index > 0,
		canNext: index < ready.length - 1,
		previous: () => go(-1),
		next: () => go(1),
		add,
		skip,
		swipe,
	};
};
