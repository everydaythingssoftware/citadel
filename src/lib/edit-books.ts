import type { BookEdit, LibraryBook } from "@/bindings";
import { formatCount, pluralize } from "@/lib/book-count";
import type { BookGridFilter } from "@/lib/book-page-cache";
import { languageNameForCode } from "@/lib/languages";
import { asciiLowerCase } from "@/lib/suggestions";
import type { EditDirection } from "@/lib/undo-history";
import { LibrarySwitchedAfterEditError } from "@/stores/library/errors";

/**
 * A text field of the selected books: one value that each book has, or
 * "mixed".
 */
export type SharedName =
	| { kind: "shared"; name: string | null }
	| { kind: "mixed" };

/** A value and the number of selected books that have it. */
export interface ValueCount {
	value: string;
	count: number;
}

/** The values that the selected books have, as the sheet shows them. */
export interface SharedFields {
	count: number;
	series: SharedName;
	/**
	 * First spelling of each tag, in name order. The sort ignores case and
	 * accents.
	 */
	tags: readonly ValueCount[];
	/** Language codes; sorted by languageNameForCode. */
	languages: readonly ValueCount[];
	publisher: SharedName;
}

/** The draft of a text field: keep the values of the books, or set one name. */
export type NameDraft = { kind: "keep" } | { kind: "set"; name: string };

/**
 * Tag names (compared ignoring case) or language codes (compared ignoring
 * case and the surrounding spaces). A value is never in `add` and in `remove`
 * at the same time.
 */
export interface TokenDraft {
	add: readonly string[];
	remove: readonly string[];
}

/** The changes that the person made in the sheet. */
export interface EditBooksDraft {
	series: NameDraft;
	tags: TokenDraft;
	languages: TokenDraft;
	publisher: NameDraft;
}

/** A draft that changes nothing. */
export const emptyEditBooksDraft: EditBooksDraft = {
	series: { kind: "keep" },
	tags: { add: [], remove: [] },
	languages: { add: [], remove: [] },
	publisher: { kind: "keep" },
};

/**
 * The form of a tag name that a comparison uses: trimmed and in ASCII
 * lowercase.
 */
export const tagKey = (name: string): string => asciiLowerCase(name.trim());

/**
 * The form of a language code that a comparison uses: trimmed and in
 * lowercase.
 */
export const languageKey = (code: string): string => code.trim().toLowerCase();

const sharedName = (values: readonly (string | null)[]): SharedName => {
	const [first] = values;
	const same = values.every((value) => value === first);
	return same ? { kind: "shared", name: first ?? null } : { kind: "mixed" };
};

const countValues = (
	lists: readonly (readonly string[])[],
	keyOf: (value: string) => string,
): ValueCount[] => {
	const counts = new Map<string, ValueCount>();
	for (const list of lists) {
		const seen = new Set<string>();
		for (const value of list) {
			const key = keyOf(value);
			if (seen.has(key)) continue;
			seen.add(key);
			const entry = counts.get(key);
			if (entry) entry.count += 1;
			else counts.set(key, { value, count: 1 });
		}
	}
	return [...counts.values()];
};

/**
 * Gives the series, the tags, the languages and the publisher that the books
 * have. A series or publisher is "mixed" unless every book has the same value.
 */
export const sharedFields = (books: readonly LibraryBook[]): SharedFields => ({
	count: books.length,
	series: sharedName(books.map((book) => book.series)),
	tags: countValues(
		books.map((book) => book.tag_list),
		tagKey,
	).sort((a, b) =>
		a.value.localeCompare(b.value, undefined, { sensitivity: "base" }),
	),
	languages: countValues(
		books.map((book) => book.language_list),
		languageKey,
	).sort((a, b) =>
		languageNameForCode(a.value).localeCompare(languageNameForCode(b.value)),
	),
	publisher: sharedName(books.map((book) => book.publisher)),
});

const unique = (
	names: readonly string[],
	keyOf: (value: string) => string,
): string[] => {
	const seen = new Set<string>();
	return names.filter((name) => {
		const key = keyOf(name);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

/** The names to add to a book, and the names of the book to remove. */
const tokenChanges = (
	current: readonly string[],
	draft: TokenDraft,
	keyOf: (value: string) => string,
): { add: string[]; remove: string[] } => {
	const have = new Set(current.map(keyOf));
	const drop = new Set(draft.remove.map(keyOf));
	return {
		add: unique(
			draft.add.map((name) => name.trim()).filter((name) => name !== ""),
			keyOf,
		).filter((name) => !have.has(keyOf(name))),
		remove: unique(
			current.filter((name) => drop.has(keyOf(name))),
			keyOf,
		),
	};
};

/**
 * The name to send for a text field, or null when the book does not change. A
 * name that differs only in ASCII case is the same series or publisher.
 */
const nameChange = (
	draft: NameDraft,
	current: string | null,
): string | null => {
	if (draft.kind === "keep") return null;
	const name = draft.name.trim();
	return asciiLowerCase(name) === asciiLowerCase(current ?? "") ? null : name;
};

/**
 * Gives one edit for each book that the draft changes. A book that the draft
 * does not change has no entry. The server calculates the undo edits from
 * its own state of each book, because the books of the grid can be older.
 */
export const editBooksEdits = (
	books: readonly LibraryBook[],
	draft: EditBooksDraft,
): BookEdit[] => {
	const forward: BookEdit[] = [];
	for (const book of books) {
		const series = nameChange(draft.series, book.series);
		const tags = tokenChanges(book.tag_list, draft.tags, tagKey);
		const languages = tokenChanges(
			book.language_list,
			draft.languages,
			languageKey,
		);
		const publisher = nameChange(draft.publisher, book.publisher);
		const changed =
			series !== null ||
			tags.add.length > 0 ||
			tags.remove.length > 0 ||
			languages.add.length > 0 ||
			languages.remove.length > 0 ||
			publisher !== null;
		if (!changed) continue;
		forward.push({
			book_id: book.id,
			series,
			add_tags: tags.add,
			remove_tags: tags.remove,
			add_languages: languages.add,
			remove_languages: languages.remove,
			publisher,
		});
	}
	return forward;
};

/**
 * A Series or Publisher field: its starting state, its draft and its raw
 * text.
 */
export interface NameField {
	start: SharedName;
	draft: NameDraft;
	/** The text as the person typed it, with its whitespace. */
	text: string;
}

const startText = (start: SharedName): string =>
	start.kind === "shared" ? (start.name ?? "") : "";

/** The field before the person does anything: keep, with the starting text. */
export const nameField = (start: SharedName): NameField => ({
	start,
	draft: { kind: "keep" },
	text: startText(start),
});

/**
 * The field after a keystroke. The draft is keep when the trimmed text is the
 * starting text. Otherwise, the draft sets the trimmed text.
 */
export const nameFieldTyped = (field: NameField, text: string): NameField => {
	const name = text.trim();
	return {
		...field,
		text,
		draft:
			name === startText(field.start)
				? { kind: "keep" }
				: { kind: "set", name },
	};
};

/** The field after a click on the clear button: set an empty name. */
export const nameFieldCleared = (field: NameField): NameField => ({
	...field,
	draft: { kind: "set", name: "" },
	text: "",
});

/** The placeholder of a Series or Publisher field that has no value. */
export type NameFieldEmptyText = "Not in a series" | "No publisher";

/**
 * The placeholder of the empty text field, or undefined when the field has a
 * value to show. `empty` is the text for a field that has no value.
 */
export const nameFieldPlaceholder = (
	field: NameField,
	empty: NameFieldEmptyText,
): string | undefined => {
	if (field.draft.kind === "set")
		return field.draft.name === "" ? empty : undefined;
	if (field.start.kind === "mixed") return "Mixed";
	return field.start.name === null ? empty : undefined;
};

/** True when the field has text, or when it shows "Mixed". */
export const showsClearButton = (field: NameField): boolean =>
	field.text !== "" ||
	(field.start.kind === "mixed" && field.draft.kind === "keep");

/** A Series or Publisher field, as the sheet renders it. */
export interface NameFieldView {
	text: string;
	placeholder: string | undefined;
	showsClear: boolean;
	/** The tooltip and the accessible name of the clear button. */
	clearLabel: string;
	onType: (text: string) => void;
	onClear: () => void;
}

/**
 * Gives what the sheet renders for a Series or Publisher field. `empty` is
 * the placeholder for a field with no value. `update` gets each change of the
 * person as a function of the current field.
 */
export const nameFieldView = (
	field: NameField,
	empty: NameFieldEmptyText,
	clearLabel: string,
	update: (change: (field: NameField) => NameField) => void,
): NameFieldView => ({
	text: field.text,
	placeholder: nameFieldPlaceholder(field, empty),
	showsClear: showsClearButton(field),
	clearLabel,
	onType: (text) => update((current) => nameFieldTyped(current, text)),
	onClear: () => update(nameFieldCleared),
});

const hasKey = (
	values: readonly string[],
	value: string,
	key: (value: string) => string,
): boolean => values.some((other) => key(other) === key(value));

const withoutKey = (
	values: readonly string[],
	value: string,
	key: (value: string) => string,
): string[] => values.filter((other) => key(other) !== key(value));

/**
 * Puts the value in `add`, and takes it out of `remove`, by `key`. A value
 * that `add` has already stays as it is. `applyTokenChange` calls this for
 * each new value. `onCommitExisting` calls it when the person commits the
 * name of a partial token again, and `onChange` calls it for a new name whose
 * value is already a token.
 */
export const tokenAdded = (
	draft: TokenDraft,
	value: string,
	key: (value: string) => string,
): TokenDraft => ({
	add: hasKey(draft.add, value, key) ? draft.add : [...draft.add, value],
	remove: withoutKey(draft.remove, value, key),
});

/** Puts the value in `remove`, and takes it out of `add`, by `key`. */
const tokenRemoved = (
	draft: TokenDraft,
	value: string,
	key: (value: string) => string,
): TokenDraft => ({
	add: withoutKey(draft.add, value, key),
	remove: hasKey(draft.remove, value, key)
		? draft.remove
		: [...draft.remove, value],
});

/**
 * Applies the change of a token field to the draft. Each value of `previous`
 * that `next` does not have is a remove. Each value of `next` that `previous`
 * does not have is an add. The comparison uses `key`.
 */
export const applyTokenChange = (
	draft: TokenDraft,
	previous: readonly string[],
	next: readonly string[],
	key: (value: string) => string,
): TokenDraft => {
	const removed = previous.filter((value) => !hasKey(next, value, key));
	const added = next.filter((value) => !hasKey(previous, value, key));
	const afterRemove = removed.reduce(
		(current, value) => tokenRemoved(current, value, key),
		draft,
	);
	return added.reduce(
		(current, value) => tokenAdded(current, value, key),
		afterRemove,
	);
};

/**
 * A token of a field: its value, the number of books that have it now, and
 * if the draft adds it to each book.
 */
export interface TokenView {
	value: string;
	count: number;
	added: boolean;
}

/**
 * Gives the tokens that the sheet shows. The tokens of the books come first,
 * in their order, without the removed values. The new values follow, in the
 * order of the draft, and not at their place by name. The edit page behaves
 * the same, because it adds a new token after the tokens of the book. A
 * value in `add` has `added` set to true, and a new value has a count of 0.
 */
export const tokenViews = (
	shared: readonly ValueCount[],
	draft: TokenDraft,
	key: (value: string) => string,
): TokenView[] => {
	const kept: TokenView[] = shared
		.filter((entry) => !hasKey(draft.remove, entry.value, key))
		.map((entry) => ({
			value: entry.value,
			count: entry.count,
			added: hasKey(draft.add, entry.value, key),
		}));
	const sharedValues = shared.map((entry) => entry.value);
	const created: TokenView[] = draft.add
		.filter((value) => !hasKey(sharedValues, value, key))
		.map((value) => ({ value, count: 0, added: true }));
	return [...kept, ...created];
};

/** A Tags or Languages field, as the props of `TagsInput`. */
export interface TokenFieldView {
	value: string[];
	suggestions: string[];
	placeholder: string;
	tokenDetail: (token: string) => string | undefined;
	removeLabel: (token: string) => string;
	onChange: (next: string[]) => void;
	onCommitExisting: (token: string) => void;
}

/** The input of `tokenFieldView`. */
export interface TokenFieldOptions {
	shared: readonly ValueCount[];
	draft: TokenDraft;
	total: number;
	key: (value: string) => string;
	/** The name that the field shows for a value. */
	toName: (value: string) => string;
	/** The value for a name that the field gives. */
	toValue: (name: string) => string;
	suggestions: string[];
	placeholder: string;
	update: (change: (draft: TokenDraft) => TokenDraft) => void;
}

/**
 * Gives the props of `TagsInput` for a Tags or Languages field. The field
 * shows names, and the draft holds values. `toName` and `toValue` convert
 * them. A partial token has a detail, for example "3 of 5". The remove label
 * gives the number of books that have the value now. A value that no book has
 * gets the label "Remove" and the token. A new name whose value is already a
 * token commits that token, as `onCommitExisting` does. `update` gets each
 * change of the person as a function of the current draft.
 */
export const tokenFieldView = ({
	shared,
	draft,
	total,
	key,
	toName,
	toValue,
	suggestions,
	placeholder,
	update,
}: TokenFieldOptions): TokenFieldView => {
	const views = tokenViews(shared, draft, key);
	const viewByName = new Map(views.map((view) => [toName(view.value), view]));
	return {
		value: views.map((view) => toName(view.value)),
		suggestions,
		placeholder,
		tokenDetail: (token) => {
			const view = viewByName.get(token);
			return view === undefined || view.added || view.count === total
				? undefined
				: `${formatCount(view.count)} of ${formatCount(total)}`;
		},
		removeLabel: (token) => {
			const count = viewByName.get(token)?.count ?? 0;
			return count === 0
				? `Remove ${token}`
				: `Remove ${token} from ${pluralize(count, "book")}`;
		},
		onChange: (next) =>
			update((current) => {
				const values = tokenViews(shared, current, key).map(
					(view) => view.value,
				);
				const names = new Set(values.map(toName));
				const newValues = next.filter((name) => !names.has(name)).map(toValue);
				return values
					.filter((value) => hasKey(newValues, value, key))
					.reduce(
						(changed, value) => tokenAdded(changed, value, key),
						applyTokenChange(current, values, next.map(toValue), key),
					);
			}),
		onCommitExisting: (token) =>
			update((current) => tokenAdded(current, toValue(token), key)),
	};
};

/**
 * True when a save can move a book out of the filter view of the grid. The
 * selection then clears after the save. `forward` is the list that
 * `editBooksEdits` gives, and it holds only the changes that take effect. A
 * field that an edit leaves out, or sets to null, keeps the value of the book.
 * The search text also matches series names, thus a series change counts
 * when the search text is not blank.
 */
export const clearsSelection = (
	filter: BookGridFilter,
	forward: readonly BookEdit[],
): boolean =>
	((filter.seriesId !== null || filter.text.trim() !== "") &&
		forward.some((edit) => edit.series != null)) ||
	(filter.tagId !== null &&
		forward.some((edit) => (edit.remove_tags?.length ?? 0) > 0)) ||
	(filter.publisherId !== null &&
		forward.some((edit) => edit.publisher != null));

/**
 * The action of an edit of several books that can fail after its sheet
 * closes.
 */
export type EditAction = "save" | EditDirection;

/**
 * The title of the banner that shows a failed save, Undo or Redo of the
 * edit.
 */
export const editFailureTitle = (action: EditAction): string => {
	switch (action) {
		case "save":
			return "Couldn't save the edit";
		case "undo":
			return "Couldn't undo the edit";
		case "redo":
			return "Couldn't redo the edit";
	}
};

/**
 * False when no banner must show for the failure of an Undo or a Redo. An
 * Undo or a Redo that applied before the library changed is not a failure of
 * the edit.
 */
export const showsEditFailure = (
	_action: EditDirection,
	error: unknown,
): boolean => !(error instanceof LibrarySwitchedAfterEditError);
