import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookEdit, EditBooksOutcome, LibraryBook } from "@/bindings";
import type { BookGridFilter } from "@/lib/book-page-cache";
import type { EditBooksDraft } from "@/lib/edit-books";
import type { UndoEntry } from "@/lib/undo-history";

const mocks = vi.hoisted(() => ({
	show: vi.fn(),
	editBooks: vi.fn<(edits: readonly BookEdit[]) => Promise<EditBooksOutcome>>(),
	registerUndo: vi.fn<(entry: UndoEntry) => void>(),
	updateBookSelection: vi.fn(),
	library: {
		confirmedLibraryPath: "/a" as string | null,
		bookFilter: null as BookGridFilter | null,
	},
}));

vi.mock("@/components/ui", () => ({ toast: { show: mocks.show } }));
vi.mock("@/stores/library/store", () => ({
	useLibraryStore: {
		getState: () => ({
			...mocks.library,
			actions: { editBooks: mocks.editBooks },
		}),
	},
}));
vi.mock("@/stores/undo/store", () => ({ registerUndo: mocks.registerUndo }));
vi.mock("@/stores/book-selection/store", () => ({
	updateBookSelection: mocks.updateBookSelection,
}));

import { ALL_BOOKS_FILTER } from "@/lib/book-page-cache";
import { clearSelection } from "@/lib/book-selection";
import { emptyEditBooksDraft } from "@/lib/edit-books";
import { UnknownOutcomeError } from "@/lib/services/library/types";
import {
	closeBooksEdit,
	type EditBooksState,
	requestBooksEdit,
	useEditBooksStore,
} from "@/stores/edit-books/store";
import { LibrarySwitchedAfterEditError } from "@/stores/library/errors";
import { type SaveState, saveBooksEdit } from "./use-edit-books-sheet";

const book = (id: string): LibraryBook => ({
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
});

const SET_SERIES: EditBooksDraft = {
	...emptyEditBooksDraft,
	series: { kind: "set", name: "Dune" },
};

const UNDO: BookEdit[] = [{ book_id: "1", series: "" }];

const openRequest = (): Extract<EditBooksState, { step: "editing" }> => {
	requestBooksEdit([book("1"), book("2")]);
	const request = useEditBooksStore.getState();
	if (request.step !== "editing") throw new Error("The sheet is not open");
	return request;
};

const saveStateSpy = () => vi.fn<(state: SaveState) => void>();

const saveStates = (setSaveState: ReturnType<typeof saveStateSpy>) =>
	setSaveState.mock.calls.map(([state]) => state);

beforeEach(() => {
	vi.resetAllMocks();
	closeBooksEdit();
	mocks.library.confirmedLibraryPath = "/a";
	mocks.library.bookFilter = ALL_BOOKS_FILTER;
	mocks.editBooks.mockResolvedValue({ undo: UNDO });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("saveBooksEdit", () => {
	it("sends no request and closes the sheet when the draft changes no book", async () => {
		const setSaveState = saveStateSpy();
		await saveBooksEdit(openRequest(), emptyEditBooksDraft, setSaveState);
		expect(mocks.editBooks).not.toHaveBeenCalled();
		expect(setSaveState).not.toHaveBeenCalled();
		expect(useEditBooksStore.getState().step).toBe("idle");
	});

	it("closes the sheet with no request when the confirmed library changed", async () => {
		const request = openRequest();
		mocks.library.confirmedLibraryPath = "/b";
		await saveBooksEdit(request, SET_SERIES, vi.fn());
		expect(mocks.editBooks).not.toHaveBeenCalled();
		expect(useEditBooksStore.getState().step).toBe("idle");
	});

	it("sends one edit for each changed book, registers Undo and closes the sheet", async () => {
		const setSaveState = saveStateSpy();
		await saveBooksEdit(openRequest(), SET_SERIES, setSaveState);
		expect(mocks.editBooks).toHaveBeenCalledOnce();
		expect(
			mocks.editBooks.mock.calls[0]?.[0].map((edit) => edit.book_id),
		).toEqual(["1", "2"]);
		expect(mocks.registerUndo).toHaveBeenCalledOnce();
		expect(mocks.registerUndo.mock.calls[0]?.[0].name).toBe("Edit Book");
		expect(saveStates(setSaveState)).toEqual([{ step: "saving" }]);
		expect(useEditBooksStore.getState().step).toBe("idle");
	});

	it("keeps the sheet open with the draft and sets the message when the save fails", async () => {
		mocks.editBooks.mockRejectedValue(new Error("Disk full"));
		const request = openRequest();
		const setSaveState = saveStateSpy();
		await saveBooksEdit(request, SET_SERIES, setSaveState);
		expect(saveStates(setSaveState)).toEqual([
			{ step: "saving" },
			{ step: "failed", message: "Couldn't save: Disk full" },
		]);
		// The same request stays open, thus the hook keeps its draft.
		expect(useEditBooksStore.getState()).toBe(request);
		expect(mocks.registerUndo).not.toHaveBeenCalled();
		expect(mocks.show).not.toHaveBeenCalled();
	});

	it("shows only the message of an unknown outcome, with no save prefix", async () => {
		mocks.editBooks.mockRejectedValue(new UnknownOutcomeError());
		const setSaveState = saveStateSpy();
		await saveBooksEdit(openRequest(), SET_SERIES, setSaveState);
		expect(saveStates(setSaveState).at(-1)).toEqual({
			step: "failed",
			message: "No answer from the server. Some books may have changed.",
		});
	});

	it("registers no undo entry when the server changed no book", async () => {
		mocks.editBooks.mockResolvedValue({ undo: [] });
		await saveBooksEdit(openRequest(), SET_SERIES, vi.fn());
		expect(mocks.registerUndo).not.toHaveBeenCalled();
		expect(useEditBooksStore.getState().step).toBe("idle");
	});

	it("closes the sheet with no message when the library changed after the edit", async () => {
		mocks.editBooks.mockRejectedValue(new LibrarySwitchedAfterEditError());
		const setSaveState = saveStateSpy();
		await saveBooksEdit(openRequest(), SET_SERIES, setSaveState);
		expect(useEditBooksStore.getState().step).toBe("idle");
		expect(saveStates(setSaveState)).toEqual([{ step: "saving" }]);
		expect(mocks.show).not.toHaveBeenCalled();
	});

	it("shows a banner when the save fails after the sheet closed", async () => {
		mocks.editBooks.mockImplementation(async () => {
			closeBooksEdit();
			throw new Error("Disk full");
		});
		const setSaveState = saveStateSpy();
		await saveBooksEdit(openRequest(), SET_SERIES, setSaveState);
		expect(mocks.show).toHaveBeenCalledWith({
			title: "Couldn't save the edit",
			message: "Disk full",
		});
		expect(saveStates(setSaveState)).toEqual([{ step: "saving" }]);
	});

	it("clears the selection when the edited books leave the filter", async () => {
		mocks.library.bookFilter = { ...ALL_BOOKS_FILTER, seriesId: 7 };
		await saveBooksEdit(openRequest(), SET_SERIES, vi.fn());
		expect(mocks.updateBookSelection).toHaveBeenCalledWith(clearSelection);
	});

	it("keeps the selection when the filter shows each book", async () => {
		await saveBooksEdit(openRequest(), SET_SERIES, vi.fn());
		expect(mocks.updateBookSelection).not.toHaveBeenCalled();
	});

	it("resets the save state and writes the error when a step after the write fails", async () => {
		const failure = new Error("No undo store");
		mocks.registerUndo.mockImplementation(() => {
			throw failure;
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const request = openRequest();
		const setSaveState = saveStateSpy();
		await expect(
			saveBooksEdit(request, SET_SERIES, setSaveState),
		).resolves.toBeUndefined();
		expect(saveStates(setSaveState)).toEqual([
			{ step: "saving" },
			{ step: "idle" },
		]);
		expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
		expect(useEditBooksStore.getState()).toBe(request);
	});

	it("shows a banner when the Undo or the Redo of the entry fails", async () => {
		await saveBooksEdit(openRequest(), SET_SERIES, vi.fn());
		const entry = mocks.registerUndo.mock.calls[0]?.[0];
		if (entry === undefined) throw new Error("No undo entry");
		mocks.editBooks.mockRejectedValue(new Error("Disk full"));

		await expect(entry.undo()).rejects.toThrow("Disk full");
		expect(mocks.show).toHaveBeenLastCalledWith({
			title: "Couldn't undo the edit",
			message: "Disk full",
		});

		await expect(entry.redo()).rejects.toThrow("Disk full");
		expect(mocks.show).toHaveBeenLastCalledWith({
			title: "Couldn't redo the edit",
			message: "Disk full",
		});
	});
});
