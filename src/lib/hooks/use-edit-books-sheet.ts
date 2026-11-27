import { useEffect, useMemo, useState } from "react";
import type { BookEdit, EditBooksOutcome, LibraryBook } from "@/bindings";
import { toast } from "@/components/ui";
import { pluralize } from "@/lib/book-count";
import { clearSelection } from "@/lib/book-selection";
import { sortedTagNames } from "@/lib/domain/tag";
import {
	clearsSelection,
	type EditBooksDraft,
	editBooksEdits,
	editFailureTitle,
	emptyEditBooksDraft,
	languageKey,
	type NameField,
	nameField,
	nameFieldView,
	sharedFields,
	showsEditFailure,
	type TokenDraft,
	tagKey,
	tokenFieldView,
} from "@/lib/edit-books";
import {
	codeForLanguageName,
	KNOWN_LANGUAGE_NAMES,
	languageNameForCode,
} from "@/lib/languages";
import { UnknownOutcomeError } from "@/lib/services/library/types";
import { type EditDirection, editBooksEntry } from "@/lib/undo-history";
import { updateBookSelection } from "@/stores/book-selection/store";
import {
	closeBooksEdit,
	closeBooksEditForLibrary,
	type EditBooksState,
	useEditBooksStore,
} from "@/stores/edit-books/store";
import { LibrarySwitchedAfterEditError } from "@/stores/library/errors";
import { useLibraryStore } from "@/stores/library/store";
import { registerUndo } from "@/stores/undo/store";

type BooksEditRequest = Extract<EditBooksState, { step: "editing" }>;

/** The save state of the sheet: idle, saving, or failed with a message. */
export type SaveState =
	| { step: "idle" }
	| { step: "saving" }
	| { step: "failed"; message: string };

const IDLE: SaveState = { step: "idle" };
const SAVING: SaveState = { step: "saving" };

/**
 * The changes of the person for the request on the screen. A null text field
 * has no change, and it shows the starting state of the books.
 */
interface SheetDraft {
	series: NameField | null;
	tags: TokenDraft;
	languages: TokenDraft;
	publisher: NameField | null;
}

type NameKey = "series" | "publisher";

const UNTOUCHED: SheetDraft = {
	series: null,
	tags: emptyEditBooksDraft.tags,
	languages: emptyEditBooksDraft.languages,
	publisher: null,
};

const NO_BOOKS: LibraryBook[] = [];

const identity = (value: string): string => value;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * The text of a failed save in the sheet. An unknown outcome shows only its
 * message, because the edit can still apply.
 */
const saveFailureText = (error: unknown): string =>
	error instanceof UnknownOutcomeError
		? error.message
		: `Couldn't save: ${errorText(error)}`;

const applyEdits = (edits: readonly BookEdit[]): Promise<EditBooksOutcome> =>
	useLibraryStore.getState().actions.editBooks(edits);

const showEditFailure = (direction: EditDirection, error: unknown) => {
	if (!showsEditFailure(direction, error)) return;
	toast.show({ title: editFailureTitle(direction), message: errorText(error) });
};

/**
 * Sends the edits of the draft for all books of the request in one call. A
 * draft that changes no book, or a request of a library that is not the
 * confirmed library, closes the sheet with no call. The sheet shows the save
 * state that `setSaveState` gets. When a step after the write throws, the
 * save state becomes idle again, so that the person can close the sheet.
 */
export const saveBooksEdit = async (
	request: BooksEditRequest,
	draft: EditBooksDraft,
	setSaveState: (state: SaveState) => void,
): Promise<void> => {
	// The books belong to the library of the request. Another library
	// must not get their ids.
	if (request.libraryPath !== useLibraryStore.getState().confirmedLibraryPath) {
		closeBooksEdit();
		return;
	}
	const forward = editBooksEdits(request.books, draft);
	if (forward.length === 0) {
		closeBooksEdit();
		return;
	}
	// Another request, a library switch or a page change can close this
	// request while the edit runs. Then the sheet on the screen is not
	// this save's.
	const isShown = () => useEditBooksStore.getState() === request;
	setSaveState(SAVING);
	let outcome: EditBooksOutcome;
	try {
		outcome = await applyEdits(forward);
	} catch (error) {
		// The edit applied, and then a library switch started. There is
		// no failure to show.
		if (error instanceof LibrarySwitchedAfterEditError) {
			if (isShown()) closeBooksEdit();
			return;
		}
		if (isShown()) {
			setSaveState({ step: "failed", message: saveFailureText(error) });
		} else {
			toast.show({
				title: editFailureTitle("save"),
				message: errorText(error),
			});
		}
		return;
	}
	try {
		if (outcome.undo.length > 0)
			registerUndo(
				editBooksEntry(forward, outcome.undo, applyEdits, showEditFailure),
			);
		if (clearsSelection(useLibraryStore.getState().bookFilter, forward))
			updateBookSelection(clearSelection);
		if (isShown()) closeBooksEdit();
	} catch (error) {
		console.error("A step after the save of several books failed", error);
		if (isShown()) setSaveState(IDLE);
	}
};

/**
 * The state of the sheet that edits several books, and one callback for each
 * action of the person. The draft starts again for each request. Save sends
 * the edits of all books in one request. It registers Undo with the undo
 * edits that the server gives, if the server changed a book. A failed save
 * keeps the sheet open with the draft, and `failure` holds the message. The
 * sheet closes when the confirmed library changes, and when the page that
 * holds the sheet unmounts.
 */
export const useEditBooksSheet = () => {
	const request = useEditBooksStore();
	const [shown, setShown] = useState<BooksEditRequest | null>(null);
	const [draft, setDraft] = useState<SheetDraft>(UNTOUCHED);
	const [saveState, setSaveState] = useState<SaveState>(IDLE);
	const saving = saveState.step === "saving";

	// A new request starts a new draft. The last request stays on the
	// screen while the sheet closes, so that the text does not empty.
	if (request.step === "editing" && request !== shown) {
		setShown(request);
		setDraft(UNTOUCHED);
		setSaveState(IDLE);
	}
	const open = request.step === "editing";
	const books = (open ? request : shown)?.books ?? NO_BOOKS;
	const shared = useMemo(() => sharedFields(books), [books]);

	const libraryTags = useLibraryStore((state) => state.tags);
	const tagsLoadFailed = useLibraryStore((state) => state.tagsLoadFailed);
	const tagSuggestions = useMemo(
		() => sortedTagNames(libraryTags ?? []),
		[libraryTags],
	);

	useEffect(() => {
		if (!open) return;
		const library = useLibraryStore.getState();
		// After a failed load, each open of the sheet tries one more time.
		if (library.tags === null || library.tagsLoadFailed)
			void library.actions.loadTags();
	}, [open]);

	const confirmedLibraryPath = useLibraryStore(
		(state) => state.confirmedLibraryPath,
	);
	useEffect(() => {
		closeBooksEditForLibrary(confirmedLibraryPath);
	}, [confirmedLibraryPath]);

	// The sheet belongs to its page: when the page unmounts, the sheet closes.
	useEffect(() => () => closeBooksEdit(), []);

	const nameFieldOf = (state: SheetDraft, key: NameKey): NameField =>
		state[key] ?? nameField(shared[key]);
	const updateName =
		(key: NameKey) => (change: (field: NameField) => NameField) =>
			setDraft((state) => ({
				...state,
				[key]: change(nameFieldOf(state, key)),
			}));

	const series = nameFieldOf(draft, "series");
	const publisher = nameFieldOf(draft, "publisher");
	const editDraft: EditBooksDraft = {
		series: series.draft,
		tags: draft.tags,
		languages: draft.languages,
		publisher: publisher.draft,
	};

	return {
		open,
		title: `Edit ${pluralize(shared.count, "book")}`,
		saving,
		failure: saveState.step === "failed" ? saveState.message : null,
		tagsLoadFailed,
		series: nameFieldView(
			series,
			"Not in a series",
			`Remove ${pluralize(shared.count, "book")} from their series`,
			updateName("series"),
		),
		tags: tokenFieldView({
			shared: shared.tags,
			draft: draft.tags,
			total: shared.count,
			key: tagKey,
			toName: identity,
			toValue: identity,
			suggestions: tagSuggestions,
			placeholder: "Search or add tag",
			update: (change) =>
				setDraft((state) => ({ ...state, tags: change(state.tags) })),
		}),
		languages: tokenFieldView({
			shared: shared.languages,
			draft: draft.languages,
			total: shared.count,
			key: languageKey,
			toName: languageNameForCode,
			toValue: codeForLanguageName,
			suggestions: KNOWN_LANGUAGE_NAMES,
			placeholder: "Search or add language",
			update: (change) =>
				setDraft((state) => ({ ...state, languages: change(state.languages) })),
		}),
		publisher: nameFieldView(
			publisher,
			"No publisher",
			`Remove the publisher from ${pluralize(shared.count, "book")}`,
			updateName("publisher"),
		),
		save: () => {
			if (request.step !== "editing" || saving) return;
			void saveBooksEdit(request, editDraft, setSaveState).catch(
				(error: unknown) =>
					console.error("The save of several books failed", error),
			);
		},
		cancel: () => {
			if (!saving) closeBooksEdit();
		},
	};
};
