import { useEffect, useMemo, useRef, useState } from "react";
import type {
	AddTo,
	BookCandidate,
	BookIntake,
	BookMatch,
} from "@/lib/services/library";
import {
	addLabel,
	addToFor,
	Destination,
	defaultDestination,
	defaultMatch,
	type TDestination,
} from "@/lib/uploads/matches";
import { type ReviewForm, reviewedFromForm } from "@/lib/uploads/review";

/** How long typing has to pause before the library is asked again. */
export const MATCH_DEBOUNCE_MS = 350;

const candidateFor = (form: ReviewForm): BookCandidate => {
	const reviewed = reviewedFromForm(form);
	return {
		title: reviewed.title ?? "",
		authorNames: reviewed.authorNames ?? [],
		identifier: reviewed.identifier ?? null,
		language: reviewed.language ?? null,
	};
};

/**
 * Books already in the library that the book under review may duplicate,
 * kept up to date as its title, authors, ISBN or language are edited: the
 * library is asked once typing pauses, and an answer that arrives after a
 * newer question is dropped. Until the first edit, what the file said is
 * what was checked when it was staged.
 */
export const useLiveMatches = ({
	intake,
	bookKey,
	form,
	staged,
}: {
	intake: BookIntake | undefined;
	bookKey: string | undefined;
	form: ReviewForm;
	staged: BookMatch[];
}): BookMatch[] => {
	const candidate = useMemo(() => candidateFor(form), [form]);
	const question = JSON.stringify(candidate);
	const [answer, setAnswer] = useState<{
		bookKey: string | undefined;
		question: string;
		matches: BookMatch[];
	}>();
	// The question the staged matches answered: the form as the book opened.
	const opened = useRef<{ bookKey: string | undefined; question: string }>(
		undefined,
	);
	if (opened.current?.bookKey !== bookKey)
		opened.current = { bookKey, question };
	const latest = useRef(0);

	useEffect(() => {
		if (!intake || !bookKey || opened.current?.question === question) return;
		const id = ++latest.current;
		const timer = setTimeout(() => {
			void intake
				.findMatches(JSON.parse(question) as BookCandidate)
				.then((matches) => {
					if (id === latest.current) setAnswer({ bookKey, question, matches });
				})
				.catch(() => {
					// A failed check says nothing; the note keeps what it had.
				});
		}, MATCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [intake, bookKey, question]);

	if (opened.current?.question === question || answer === undefined)
		return staged;
	return answer.bookKey === bookKey ? answer.matches : staged;
};

interface Choice {
	bookKey: string | undefined;
	destination: TDestination;
	selectedId: string | undefined;
}

export interface MatchChoice {
	destination: TDestination;
	selected: BookMatch | undefined;
	/** The same book as this match, or (null) a different book. */
	choose: (id: string | null) => void;
	/** What adding sends, and what its button says. */
	addTo: AddTo;
	addLabel: string;
}

/**
 * Where the book under review goes. A strong match (same ISBN, or same
 * title and an author) makes adding to the existing book the default; a
 * match on title alone defaults to a new book. Each book starts from its
 * own default, taken from what its file matched: matches found while
 * editing it don't move a book that's being edited out of its form.
 */
export const useMatchChoice = ({
	bookKey,
	staged,
	matches,
	formats,
}: {
	bookKey: string | undefined;
	/** What the book's file matched when it was staged. */
	staged: BookMatch[];
	/** What it matches now, as edited. */
	matches: BookMatch[];
	formats: readonly string[];
}): MatchChoice => {
	const [choice, setChoice] = useState<Choice>();
	const current: Choice =
		choice !== undefined && choice.bookKey === bookKey
			? choice
			: {
					bookKey,
					destination: defaultDestination(staged),
					selectedId: defaultMatch(staged)?.id,
				};
	const selected =
		matches.find((match) => match.id === current.selectedId) ??
		defaultMatch(matches);
	const destination = matches.length > 0 ? current.destination : "new";
	return {
		destination,
		selected,
		choose: (id) =>
			setChoice(
				id === null
					? { ...current, destination: Destination.new }
					: { ...current, destination: Destination.existing, selectedId: id },
			),
		addTo: addToFor(destination, selected),
		addLabel: addLabel(destination, selected, formats, matches.length > 0),
	};
};
