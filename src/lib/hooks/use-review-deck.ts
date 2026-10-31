import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewedBook } from "@/lib/services/library";
import type { QueueItem } from "@/lib/uploads/queue";
import {
	canAddForm,
	fieldProblem,
	formForBook,
	type ReviewField,
	type ReviewForm,
	reviewedFromForm,
	tidyField,
} from "@/lib/uploads/review";
import { useKeymap } from "./use-keymap";

export const CoverExit = {
	added: "added",
	skipped: "skipped",
} as const;
export type TCoverExit = (typeof CoverExit)[keyof typeof CoverExit];

/** How long a departing cover takes to leave; matches the CSS animations. */
export const LEAVE_MS = 520;

/** A cover on its way out of the carousel after its book was added or skipped. */
export interface DepartingCover {
	item: QueueItem;
	/** Where it sat among the ready books. */
	index: number;
	exit: TCoverExit;
}

export interface ReviewDeck {
	/** The ready books, in carousel order. */
	items: QueueItem[];
	current: QueueItem | undefined;
	index: number;
	count: number;
	form: ReviewForm;
	/** Problems with fields the person has left (or tried to add with). */
	errors: Partial<Record<ReviewField, string>>;
	updateForm: (patch: Partial<ReviewForm>) => void;
	/** A field lost focus: show its problem from now on and tidy it. */
	leaveField: (field: ReviewField) => void;
	departing: DepartingCover | undefined;
	canPrevious: boolean;
	canNext: boolean;
	previous: () => void;
	next: () => void;
	select: (index: number) => void;
	add: () => Promise<void>;
	skip: () => Promise<void>;
}

interface Draft {
	form: ReviewForm;
	touched: ReviewField[];
}

const ALL_FIELDS: ReviewField[] = [
	"title",
	"authors",
	"publisher",
	"language",
	"tags",
	"publicationDate",
	"identifier",
];

/**
 * Pages through ready books: the current one's form switches instantly and
 * keeps each book's unsaved edits, so paging away and back loses nothing.
 * Added and skipped books leave through a departing cover the carousel
 * animates.
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
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [departing, setDeparting] = useState<DepartingCover>();
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	// A book being added leaves the list a moment before the deck moves on;
	// hold the position meanwhile rather than jumping back to the first book.
	const lastIndex = useRef(0);
	const found = ready.findIndex((item) => item.key === reviewKey);
	const index =
		found >= 0
			? found
			: Math.max(0, Math.min(lastIndex.current, ready.length - 1));
	lastIndex.current = index;
	const current = ready[index];
	const draft = useMemo<Draft>(
		() =>
			(current && drafts[current.key]) ?? {
				form: formForBook(current?.book),
				touched: [],
			},
		[current, drafts],
	);
	const errors = useMemo(
		() =>
			Object.fromEntries(
				draft.touched
					.map((field) => [field, fieldProblem(draft.form, field)] as const)
					.filter(([, problem]) => problem !== undefined),
			) as Partial<Record<ReviewField, string>>,
		[draft],
	);

	useEffect(() => () => clearTimeout(timer.current), []);

	const saveDraft = useCallback(
		(change: (draft: Draft) => Draft) => {
			if (!current) return;
			setDrafts((all) => ({ ...all, [current.key]: change(draft) }));
		},
		[current, draft],
	);

	const select = useCallback(
		(target: number) => {
			const item = ready[target];
			if (item && item.key !== current?.key) setReviewKey(item.key);
		},
		[ready, current, setReviewKey],
	);

	/** Removes the current book from view: next ready book, else the previous. */
	/**
	 * Marks the current book's cover as leaving before the book leaves the
	 * list, so the carousel keeps its element in place and animates it out.
	 */
	const depart = useCallback(
		(item: QueueItem, exit: TCoverExit) => {
			clearTimeout(timer.current);
			setDeparting({ item, index, exit });
			// With no other book, stay on this one while its cover leaves.
			return (ready[index + 1] ?? ready[index - 1])?.key ?? item.key;
		},
		[index, ready],
	);

	// The leave animation runs once the book has actually left the list.
	const departingGone =
		departing !== undefined &&
		!ready.some((item) => item.key === departing.item.key);
	useEffect(() => {
		if (!departingGone) return;
		timer.current = setTimeout(() => setDeparting(undefined), LEAVE_MS);
		return () => clearTimeout(timer.current);
	}, [departingGone]);

	const forget = useCallback(
		(key: string) => setDrafts(({ [key]: _, ...rest }) => rest),
		[],
	);

	const add = useCallback(async () => {
		if (!current) return;
		if (!canAddForm(draft.form)) {
			saveDraft((before) => ({ ...before, touched: ALL_FIELDS }));
			return;
		}
		const item = current;
		const after = depart(item, CoverExit.added);
		if (await onAdd(item.key, reviewedFromForm(draft.form))) {
			setReviewKey(after);
			forget(item.key);
		} else {
			setDeparting(undefined);
		}
	}, [current, draft, onAdd, depart, saveDraft, setReviewKey, forget]);

	const skip = useCallback(async () => {
		if (!current) return;
		const item = current;
		setReviewKey(depart(item, CoverExit.skipped));
		forget(item.key);
		await onSkip(item.key);
	}, [current, onSkip, depart, setReviewKey, forget]);

	useKeymap(
		keyboard
			? [
					{ chord: "arrowleft", onMatch: () => select(index - 1) },
					{ chord: "arrowright", onMatch: () => select(index + 1) },
				]
			: [],
	);

	return {
		items: ready,
		current,
		index,
		count: ready.length,
		form: draft.form,
		errors,
		updateForm: (patch) =>
			saveDraft((before) => ({
				...before,
				form: { ...before.form, ...patch },
			})),
		leaveField: (field) =>
			saveDraft((before) => ({
				form: { ...before.form, ...tidyField(before.form, field) },
				touched: before.touched.includes(field)
					? before.touched
					: [...before.touched, field],
			})),
		departing,
		canPrevious: index > 0,
		canNext: index < ready.length - 1,
		previous: () => select(index - 1),
		next: () => select(index + 1),
		select,
		add,
		skip,
	};
};
