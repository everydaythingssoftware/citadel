import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import { ALL_BOOKS_FILTER } from "@/lib/book-page-cache";
import { codeForLanguageName, languageNameForCode } from "@/lib/languages";
import { LibrarySwitchedAfterEditError } from "@/stores/library/errors";
import {
	applyTokenChange,
	clearsSelection,
	type EditBooksDraft,
	editBooksEdits,
	editFailureTitle,
	emptyEditBooksDraft,
	languageKey,
	type NameField,
	nameField,
	nameFieldCleared,
	nameFieldPlaceholder,
	nameFieldTyped,
	nameFieldView,
	type SharedName,
	sharedFields,
	showsClearButton,
	showsEditFailure,
	type TokenDraft,
	tagKey,
	tokenAdded,
	tokenFieldView,
	tokenViews,
} from "./edit-books";

const book = (
	id: string,
	overrides: Partial<LibraryBook> = {},
): LibraryBook => ({
	id,
	uuid: null,
	title: `Book ${id}`,
	author_list: [],
	tag_list: [],
	sortable_title: null,
	file_list: [],
	cover_image: null,
	identifier_list: [],
	description: null,
	is_read: false,
	series: null,
	series_index: null,
	publisher: null,
	language_list: [],
	added_at: "2026-01-01T00:00:00Z",
	...overrides,
});

const draft = (overrides: Partial<EditBooksDraft>): EditBooksDraft => ({
	...emptyEditBooksDraft,
	...overrides,
});

describe("sharedFields", () => {
	it("shares a value that every book has", () => {
		const books = [1, 2, 3].map((n) => book(String(n), { series: "Dune" }));
		expect(sharedFields(books).series).toEqual({
			kind: "shared",
			name: "Dune",
		});
	});

	it("shares no value when no book has one", () => {
		const fields = sharedFields([book("1"), book("2")]);
		expect(fields.series).toEqual({ kind: "shared", name: null });
		expect(fields.publisher).toEqual({ kind: "shared", name: null });
	});

	it("is mixed when only some books have a series", () => {
		const books = [book("1"), book("2", { series: "Dune" })];
		expect(sharedFields(books).series).toEqual({ kind: "mixed" });
	});

	it("is mixed when the books have different publishers", () => {
		const books = [
			book("1", { publisher: "A" }),
			book("2", { publisher: "B" }),
		];
		expect(sharedFields(books).publisher).toEqual({ kind: "mixed" });
	});

	it("counts each tag and keeps its first spelling", () => {
		const books = [
			book("1", { tag_list: ["Epic", "a"] }),
			book("2", { tag_list: ["epic", "a"] }),
		];
		const fields = sharedFields(books);
		expect(fields.count).toBe(2);
		expect(fields.tags).toEqual([
			{ value: "a", count: 2 },
			{ value: "Epic", count: 2 },
		]);
	});

	it("counts a stored code ENG and a code eng as one language", () => {
		const books = [
			book("1", { language_list: ["ENG"] }),
			book("2", { language_list: ["eng"] }),
		];
		expect(sharedFields(books).languages).toEqual([{ value: "ENG", count: 2 }]);
	});

	it("counts each language code", () => {
		const books = [
			book("1", { language_list: ["deu", "eng"] }),
			book("2", { language_list: ["eng"] }),
		];
		expect(sharedFields(books).languages).toEqual([
			{ value: "eng", count: 2 },
			{ value: "deu", count: 1 },
		]);
	});
});

describe("editBooksEdits", () => {
	it("gives no entry for a book that the draft does not change", () => {
		const books = [
			book("1", { tag_list: ["a"] }),
			book("2", { tag_list: ["A"] }),
		];
		const result = editBooksEdits(
			books,
			draft({ tags: { add: ["a"], remove: [] } }),
		);
		expect(result).toEqual([]);
	});

	it("adds only to the books without the tag, ignoring case", () => {
		const books = [
			book("1", { tag_list: ["Epic"] }),
			book("2", { tag_list: [] }),
		];
		const forward = editBooksEdits(
			books,
			draft({ tags: { add: ["epic"], remove: [] } }),
		);
		expect(forward).toEqual([
			{
				book_id: "2",
				series: null,
				add_tags: ["epic"],
				remove_tags: [],
				add_languages: [],
				remove_languages: [],
				publisher: null,
			},
		]);
	});

	it("removes with the spelling of the book", () => {
		const books = [book("1", { tag_list: ["Epic"] }), book("2")];
		const forward = editBooksEdits(
			books,
			draft({ tags: { add: [], remove: ["EPIC"] } }),
		);
		expect(forward).toHaveLength(1);
		expect(forward[0]?.remove_tags).toEqual(["Epic"]);
	});

	it("gives no entry for an add of a blank name", () => {
		const result = editBooksEdits(
			[book("1")],
			draft({ tags: { add: ["   "], remove: [] } }),
		);
		expect(result).toEqual([]);
	});

	it("trims the name that it adds", () => {
		const forward = editBooksEdits(
			[book("1")],
			draft({ tags: { add: [" epic "], remove: [] } }),
		);
		expect(forward[0]?.add_tags).toEqual(["epic"]);
	});

	it("gives the adds and the removes of the tags and the languages", () => {
		const books = [book("1", { tag_list: ["old"], language_list: ["fra"] })];
		const forward = editBooksEdits(
			books,
			draft({
				tags: { add: ["new"], remove: ["old"] },
				languages: { add: ["eng"], remove: ["fra"] },
			}),
		);
		expect(forward[0]?.add_tags).toEqual(["new"]);
		expect(forward[0]?.remove_tags).toEqual(["old"]);
		expect(forward[0]?.add_languages).toEqual(["eng"]);
		expect(forward[0]?.remove_languages).toEqual(["fra"]);
	});

	it("compares trimmed language codes ignoring case", () => {
		const books = [book("1", { language_list: ["ENG"] })];
		expect(
			editBooksEdits(books, draft({ languages: { add: ["eng"], remove: [] } })),
		).toEqual([]);
		const forward = editBooksEdits(
			books,
			draft({ languages: { add: [], remove: [" eng "] } }),
		);
		expect(forward[0]?.remove_languages).toEqual(["ENG"]);
	});

	it("sets the series of a book with another series or with none", () => {
		const books = [book("1", { series: "Old" }), book("2")];
		const forward = editBooksEdits(
			books,
			draft({ series: { kind: "set", name: "New" } }),
		);
		expect(forward.map((edit) => edit.series)).toEqual(["New", "New"]);
	});

	it("sets the series only where it differs", () => {
		const books = [book("1", { series: "Dune" }), book("2")];
		const forward = editBooksEdits(
			books,
			draft({ series: { kind: "set", name: "Dune" } }),
		);
		expect(forward.map((edit) => edit.book_id)).toEqual(["2"]);
	});

	it("gives no entry for a series or a publisher that differs only in ASCII case", () => {
		const books = [book("1", { series: "Dune", publisher: "Ace" })];
		expect(
			editBooksEdits(books, draft({ series: { kind: "set", name: "dune" } })),
		).toEqual([]);
		expect(
			editBooksEdits(books, draft({ publisher: { kind: "set", name: "ACE" } })),
		).toEqual([]);
	});

	it("sets a series that differs in the case of a letter that is not ASCII", () => {
		const books = [book("1", { series: "Élan" })];
		const forward = editBooksEdits(
			books,
			draft({ series: { kind: "set", name: "élan" } }),
		);
		expect(forward.map((edit) => edit.series)).toEqual(["élan"]);
	});

	it("does not change a book with no value when the draft sets an empty name", () => {
		const books = [book("1", { publisher: "Ace" }), book("2")];
		const forward = editBooksEdits(
			books,
			draft({ publisher: { kind: "set", name: "" } }),
		);
		expect(forward.map((edit) => edit.book_id)).toEqual(["1"]);
		expect(forward[0]?.publisher).toBe("");
	});

	it("keeps the edits of 10,000 books under 16 MiB", () => {
		const books = Array.from({ length: 10_000 }, (_, index) =>
			book(String(index + 1), {
				series: "A series name",
				tag_list: ["one", "two", "three"],
				language_list: ["eng"],
				publisher: "A publisher name",
			}),
		);
		const forward = editBooksEdits(
			books,
			draft({
				series: { kind: "set", name: "Other" },
				tags: { add: [], remove: ["one", "two", "three"] },
				languages: { add: [], remove: ["eng"] },
				publisher: { kind: "set", name: "Other" },
			}),
		);
		expect(forward).toHaveLength(10_000);
		expect(JSON.stringify({ edits: forward }).length).toBeLessThan(
			16 * 1024 * 1024,
		);
	});
});

describe("tagKey", () => {
	it("compares tag names ignoring case and the surrounding spaces", () => {
		expect(tagKey(" Epic ")).toBe(tagKey("EPIC"));
	});

	it("keeps the case of a letter that is not ASCII, as SQLite NOCASE does", () => {
		expect(tagKey("Ästhetik")).not.toBe(tagKey("ästhetik"));
		const books = [
			book("1", { tag_list: ["Ästhetik"] }),
			book("2", { tag_list: ["ästhetik"] }),
		];
		expect(sharedFields(books).tags).toEqual([
			{ value: "Ästhetik", count: 1 },
			{ value: "ästhetik", count: 1 },
		]);
		const forward = editBooksEdits(
			books,
			draft({ tags: { add: ["Ästhetik"], remove: [] } }),
		);
		expect(forward.map((edit) => edit.book_id)).toEqual(["2"]);
	});
});

describe("editFailureTitle", () => {
	it("names the action that failed", () => {
		expect(editFailureTitle("save")).toBe("Couldn't save the edit");
		expect(editFailureTitle("undo")).toBe("Couldn't undo the edit");
		expect(editFailureTitle("redo")).toBe("Couldn't redo the edit");
	});
});

describe("showsEditFailure", () => {
	it("shows each failure of an Undo and a Redo", () => {
		for (const action of ["undo", "redo"] as const)
			expect(showsEditFailure(action, new Error("refused"))).toBe(true);
	});
	it("shows no banner when an Undo or a Redo applied before the library changed", () => {
		expect(showsEditFailure("undo", new LibrarySwitchedAfterEditError())).toBe(
			false,
		);
		expect(showsEditFailure("redo", new LibrarySwitchedAfterEditError())).toBe(
			false,
		);
	});
});

const mixed: SharedName = { kind: "mixed" };
const shared = (name: string | null): SharedName => ({ kind: "shared", name });
const noChange: TokenDraft = { add: [], remove: [] };

describe("name field", () => {
	it("starts as keep with the starting text", () => {
		expect(nameField(shared("Dune"))).toEqual({
			start: shared("Dune"),
			draft: { kind: "keep" },
			text: "Dune",
		});
		expect(nameField(shared(null)).text).toBe("");
		expect(nameField(mixed).text).toBe("");
		expect(nameField(mixed).draft).toEqual({ kind: "keep" });
	});

	it("sets the trimmed text, and keeps when the text is the start again", () => {
		const typed = nameFieldTyped(nameField(shared("Dune")), "  Emma ");
		expect(typed.text).toBe("  Emma ");
		expect(typed.draft).toEqual({ kind: "set", name: "Emma" });
		expect(nameFieldTyped(typed, "Dune ").draft).toEqual({ kind: "keep" });
		expect(nameFieldTyped(nameField(shared(null)), "   ").draft).toEqual({
			kind: "keep",
		});
	});

	it("keeps an empty mixed field, with the placeholder Mixed", () => {
		const field = nameFieldTyped(nameField(mixed), "  ");
		expect(field.draft).toEqual({ kind: "keep" });
		expect(nameFieldPlaceholder(field, "No publisher")).toBe("Mixed");
	});

	it('clears to set(""), and the next keystroke sets the trimmed text or keeps at the starting text', () => {
		let field = nameFieldTyped(nameField(mixed), "Foo");
		field = nameFieldCleared(field);
		expect(field.draft).toEqual({ kind: "set", name: "" });
		expect(field.text).toBe("");
		field = nameFieldTyped(field, "F");
		expect(field.draft).toEqual({ kind: "set", name: "F" });
		field = nameFieldTyped(field, "");
		expect(field.draft).toEqual({ kind: "keep" });
	});

	it('shows the empty placeholder while the draft is set("")', () => {
		const field = nameFieldCleared(nameField(mixed));
		expect(nameFieldPlaceholder(field, "Not in a series")).toBe(
			"Not in a series",
		);
		expect(nameFieldPlaceholder(nameField(shared(null)), "No publisher")).toBe(
			"No publisher",
		);
		expect(
			nameFieldPlaceholder(nameField(shared("Dune")), "No publisher"),
		).toBe(undefined);
	});

	it("shows the clear button with text or while mixed and kept", () => {
		expect(showsClearButton(nameField(shared("Dune")))).toBe(true);
		expect(showsClearButton(nameField(shared(null)))).toBe(false);
		expect(showsClearButton(nameField(mixed))).toBe(true);
		expect(showsClearButton(nameFieldCleared(nameField(mixed)))).toBe(false);
		expect(showsClearButton(nameFieldTyped(nameField(mixed), "F"))).toBe(true);
		const emptied = nameFieldTyped(nameFieldTyped(nameField(mixed), "F"), "");
		expect(showsClearButton(emptied)).toBe(true);
	});

	it("unlinks a shared value when its text becomes empty", () => {
		const field = nameFieldTyped(nameField(shared("Tor")), "");
		expect(field.draft).toEqual({ kind: "set", name: "" });
		expect(nameFieldPlaceholder(field, "No publisher")).toBe("No publisher");
	});
});

describe("tokens", () => {
	it("removes a value from each book", () => {
		const result = applyTokenChange(noChange, ["a", "b"], ["a"], tagKey);
		expect(result).toEqual({ add: [], remove: ["b"] });
	});

	it("adds a new value to each book", () => {
		const result = applyTokenChange(noChange, ["a"], ["a", "b"], tagKey);
		expect(result).toEqual({ add: ["b"], remove: [] });
	});

	it("makes a partial token full when its name is committed again", () => {
		const shared = [{ value: "Epic", count: 3 }];
		const before = tokenViews(shared, noChange, tagKey);
		expect(before).toEqual([{ value: "Epic", count: 3, added: false }]);
		const draft = tokenAdded(noChange, "Epic", tagKey);
		expect(tokenViews(shared, draft, tagKey)).toEqual([
			{ value: "Epic", count: 3, added: true },
		]);
	});

	it("keeps a value out of add and remove together", () => {
		const removed = tokenAdded({ add: [], remove: ["Epic"] }, "epic", tagKey);
		expect(removed).toEqual({ add: ["epic"], remove: [] });
		expect(tokenAdded(removed, "EPIC", tagKey)).toEqual(removed);
	});

	it("drops an add of a value that the draft then removes", () => {
		const added = applyTokenChange(noChange, [], ["x"], tagKey);
		const result = applyTokenChange(added, ["x"], [], tagKey);
		expect(result.add).toEqual([]);
		expect(result.remove).toEqual(["x"]);
	});

	it("drops the add of a value of the books that the draft made full", () => {
		const made = tokenAdded(noChange, "Epic", tagKey);
		const result = applyTokenChange(made, ["Epic"], [], tagKey);
		expect(result).toEqual({ add: [], remove: ["Epic"] });
	});

	it("removes by key a value that the draft added with other case", () => {
		const added = applyTokenChange(noChange, [], ["Epic"], tagKey);
		const result = applyTokenChange(added, ["EPIC"], [], tagKey);
		expect(result).toEqual({ add: [], remove: ["EPIC"] });
	});

	it("shows the removed values no more, and the added values as full", () => {
		const shared = [
			{ value: "a", count: 5 },
			{ value: "b", count: 2 },
		];
		const draft = { add: ["new"], remove: ["a"] };
		expect(tokenViews(shared, draft, tagKey)).toEqual([
			{ value: "b", count: 2, added: false },
			{ value: "new", count: 0, added: true },
		]);
	});

	it("compares tags ignoring case", () => {
		const added = applyTokenChange(noChange, ["Epic"], ["epic"], tagKey);
		expect(added).toEqual({ add: [], remove: [] });
		const removed = applyTokenChange(noChange, ["Epic", "x"], ["x"], tagKey);
		expect(removed.remove).toEqual(["Epic"]);
		const views = tokenViews(
			[{ value: "Epic", count: 2 }],
			{ add: ["epic"], remove: [] },
			tagKey,
		);
		expect(views).toEqual([{ value: "Epic", count: 2, added: true }]);
	});
});

describe("clearsSelection", () => {
	const forwardOf = (books: LibraryBook[], changes: EditBooksDraft) =>
		editBooksEdits(books, changes);

	it("is true for a tag filter and a removed tag", () => {
		const forward = forwardOf(
			[book("1", { tag_list: ["a"] })],
			draft({ tags: { add: [], remove: ["a"] } }),
		);
		expect(clearsSelection({ ...ALL_BOOKS_FILTER, tagId: 1 }, forward)).toBe(
			true,
		);
	});

	it("is true for a series filter and a set series, and a publisher filter and a set publisher", () => {
		const books = [book("1", { series: "Old", publisher: "Old" })];
		expect(
			clearsSelection(
				{ ...ALL_BOOKS_FILTER, seriesId: 1 },
				forwardOf(books, draft({ series: { kind: "set", name: "" } })),
			),
		).toBe(true);
		expect(
			clearsSelection(
				{ ...ALL_BOOKS_FILTER, publisherId: 1 },
				forwardOf(books, draft({ publisher: { kind: "set", name: "Ace" } })),
			),
		).toBe(true);
	});

	it("is true for a search text and a set series, because the search matches series names", () => {
		const forward = forwardOf(
			[book("1", { series: "The Expanse" })],
			draft({ series: { kind: "set", name: "" } }),
		);
		expect(
			clearsSelection({ ...ALL_BOOKS_FILTER, text: "Expanse" }, forward),
		).toBe(true);
	});

	it("is false for a blank search text and a set series, and for a search text and a tag edit", () => {
		const books = [book("1", { series: "S", tag_list: ["a"] })];
		expect(
			clearsSelection(
				{ ...ALL_BOOKS_FILTER, text: "  " },
				forwardOf(books, draft({ series: { kind: "set", name: "X" } })),
			),
		).toBe(false);
		expect(
			clearsSelection(
				{ ...ALL_BOOKS_FILTER, text: "S" },
				forwardOf(books, draft({ tags: { add: [], remove: ["a"] } })),
			),
		).toBe(false);
	});

	it("is false for a tag filter and an added tag only", () => {
		const forward = forwardOf(
			[book("1")],
			draft({ tags: { add: ["a"], remove: [] } }),
		);
		expect(clearsSelection({ ...ALL_BOOKS_FILTER, tagId: 1 }, forward)).toBe(
			false,
		);
	});

	it("is false with no filter", () => {
		const forward = forwardOf(
			[book("1", { series: "S", tag_list: ["a"], publisher: "P" })],
			draft({
				series: { kind: "set", name: "X" },
				tags: { add: [], remove: ["a"] },
				publisher: { kind: "set", name: "Y" },
			}),
		);
		expect(clearsSelection(ALL_BOOKS_FILTER, forward)).toBe(false);
	});

	it("is false for a tag filter and a tag that the person adds and removes", () => {
		const changes = draft({
			tags: applyTokenChange(
				applyTokenChange(noChange, [], ["x"], tagKey),
				["x"],
				[],
				tagKey,
			),
		});
		const forward = forwardOf([book("1", { tag_list: ["a"] })], changes);
		expect(forward).toEqual([]);
		expect(clearsSelection({ ...ALL_BOOKS_FILTER, tagId: 1 }, forward)).toBe(
			false,
		);
	});

	it("is false for a series filter and a publisher filter when the edits leave out those fields", () => {
		const forward = [{ book_id: "1", add_tags: ["a"] }];
		expect(clearsSelection({ ...ALL_BOOKS_FILTER, seriesId: 1 }, forward)).toBe(
			false,
		);
		expect(
			clearsSelection({ ...ALL_BOOKS_FILTER, publisherId: 1 }, forward),
		).toBe(false);
	});

	it("is false for a series filter and a series that every book has", () => {
		const forward = forwardOf(
			[book("1", { series: "Dune" }), book("2", { series: "Dune" })],
			draft({ series: { kind: "set", name: "Dune" } }),
		);
		expect(clearsSelection({ ...ALL_BOOKS_FILTER, seriesId: 1 }, forward)).toBe(
			false,
		);
	});
});

/**
 * Holds a value and applies each change of a field view to it, as the hook
 * does with its state.
 */
const holder = <TValue>(start: TValue) => {
	let value = start;
	return {
		update: (change: (current: TValue) => TValue) => {
			value = change(value);
		},
		get value() {
			return value;
		},
	};
};

describe("name field view", () => {
	it("shows a mixed field with the placeholder Mixed and the clear button", () => {
		const field = holder<NameField>(nameField({ kind: "mixed" }));
		const view = nameFieldView(
			field.value,
			"Not in a series",
			"Remove 5 books from their series",
			field.update,
		);
		expect(view).toMatchObject({
			text: "",
			placeholder: "Mixed",
			showsClear: true,
			clearLabel: "Remove 5 books from their series",
		});
	});

	it("changes the draft after a keystroke and after a click on the clear button", () => {
		const field = holder<NameField>(nameField({ kind: "mixed" }));
		const view = () =>
			nameFieldView(field.value, "No publisher", "Clear", field.update);
		view().onType("Tor");
		expect(field.value.draft).toEqual({ kind: "set", name: "Tor" });
		view().onClear();
		expect(field.value.draft).toEqual({ kind: "set", name: "" });
		expect(view()).toMatchObject({
			text: "",
			placeholder: "No publisher",
			showsClear: false,
		});
	});
});

describe("token field view", () => {
	const tagField = (draft: ReturnType<typeof holder<TokenDraft>>) =>
		tokenFieldView({
			shared: [
				{ value: "Epic", count: 3 },
				{ value: "Fantasy", count: 5 },
			],
			draft: draft.value,
			total: 5,
			key: tagKey,
			toName: (name) => name,
			toValue: (name) => name,
			suggestions: ["Epic", "Fantasy", "Horror"],
			placeholder: "Search or add tag",
			update: draft.update,
		});

	const languageField = (draft: ReturnType<typeof holder<TokenDraft>>) =>
		tokenFieldView({
			shared: [
				{ value: "cat", count: 2 },
				{ value: "eng", count: 5 },
			],
			draft: draft.value,
			total: 5,
			key: (code) => code,
			toName: languageNameForCode,
			toValue: codeForLanguageName,
			suggestions: [],
			placeholder: "Search or add language",
			update: draft.update,
		});

	it("gives the detail and the remove label of a partial token", () => {
		const field = tagField(holder(noChange));
		expect(field.value).toEqual(["Epic", "Fantasy"]);
		expect(field.tokenDetail("Epic")).toBe("3 of 5");
		expect(field.removeLabel("Epic")).toBe("Remove Epic from 3 books");
	});

	it("gives no detail to a full token, and names every book in its remove label", () => {
		const field = tagField(holder(noChange));
		expect(field.tokenDetail("Fantasy")).toBeUndefined();
		expect(field.removeLabel("Fantasy")).toBe("Remove Fantasy from 5 books");
	});

	it("makes a partial token full when its name is committed again", () => {
		const draft = holder(noChange);
		tagField(draft).onCommitExisting("Epic");
		expect(draft.value).toEqual({ add: ["Epic"], remove: [] });
		const field = tagField(draft);
		expect(field.tokenDetail("Epic")).toBeUndefined();
		expect(field.removeLabel("Epic")).toBe("Remove Epic from 3 books");
	});

	it("gives no detail to a new token, and no count in its remove label", () => {
		const draft = holder(noChange);
		tagField(draft).onChange(["Epic", "Fantasy", "Horror"]);
		const field = tagField(draft);
		expect(field.tokenDetail("Horror")).toBeUndefined();
		expect(field.removeLabel("Horror")).toBe("Remove Horror");
	});

	it("adds and removes tags through the change of the field", () => {
		const draft = holder(noChange);
		tagField(draft).onChange(["Fantasy", "Horror"]);
		expect(draft.value).toEqual({ add: ["Horror"], remove: ["Epic"] });
		expect(tagField(draft).value).toEqual(["Fantasy", "Horror"]);
	});

	it("shows language codes as names", () => {
		expect(languageField(holder(noChange)).value).toEqual(["CAT", "English"]);
	});

	it("gives back the code of each name: eng to English to eng, and cat to CAT to cat", () => {
		const draft = holder(noChange);
		languageField(draft).onChange(["CAT", "English"]);
		expect(draft.value).toEqual(noChange);
		languageField(draft).onChange(["English"]);
		expect(draft.value).toEqual({ add: [], remove: ["cat"] });
		languageField(draft).onChange(["English", "French"]);
		expect(draft.value).toEqual({ add: ["fra"], remove: ["cat"] });
	});

	it("commits a typed code of a partial language as that language", () => {
		const books = [1, 2, 3, 4, 5].map((n) =>
			book(String(n), { language_list: n <= 2 ? ["fra"] : [] }),
		);
		const shared = sharedFields(books).languages;
		const draft = holder(noChange);
		const field = () =>
			tokenFieldView({
				shared,
				draft: draft.value,
				total: 5,
				key: (code) => code,
				toName: languageNameForCode,
				toValue: codeForLanguageName,
				suggestions: [],
				placeholder: "Search or add language",
				update: draft.update,
			});
		expect(field().tokenDetail("French")).toBe("2 of 5");
		field().onChange(["French", "fra"]);
		expect(draft.value).toEqual({ add: ["fra"], remove: [] });
		expect(field().value).toEqual(["French"]);
		expect(field().tokenDetail("French")).toBeUndefined();
		const forward = editBooksEdits(books, {
			...emptyEditBooksDraft,
			languages: draft.value,
		});
		expect(forward.map((edit) => edit.add_languages)).toEqual([
			["fra"],
			["fra"],
			["fra"],
		]);
	});

	it("commits an existing language name as its code", () => {
		const draft = holder(noChange);
		languageField(draft).onCommitExisting("CAT");
		expect(draft.value).toEqual({ add: ["cat"], remove: [] });
		expect(languageField(draft).tokenDetail("CAT")).toBeUndefined();
	});

	it("keeps one token for a stored code ENG when English is committed", () => {
		const draft = holder(noChange);
		const field = () =>
			tokenFieldView({
				shared: [{ value: "ENG", count: 2 }],
				draft: draft.value,
				total: 5,
				key: languageKey,
				toName: languageNameForCode,
				toValue: codeForLanguageName,
				suggestions: [],
				placeholder: "Search or add language",
				update: draft.update,
			});
		field().onCommitExisting("English");
		expect(draft.value).toEqual({ add: ["eng"], remove: [] });
		expect(field().value).toEqual(["English"]);
		expect(field().tokenDetail("English")).toBeUndefined();
	});
});
