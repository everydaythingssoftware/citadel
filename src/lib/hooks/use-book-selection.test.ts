import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requestBooksEdit: vi.fn(),
}));

vi.mock("@/stores/edit-books/store", () => ({
	requestBooksEdit: mocks.requestBooksEdit,
}));

import type { LibraryBook } from "@/bindings";
import { BOOK_COMMAND } from "@/lib/book-menu";
import { emptySelection } from "@/lib/book-selection";
import { none } from "@/lib/option";
import type { PlatformAdapter } from "@/lib/platform/types";
import type { Library } from "@/lib/services/library";
import { useBookSelectionStore } from "@/stores/book-selection/store";
import { useLibraryStore } from "@/stores/library/store";
import { type BookCommandDeps, bookCommands } from "./use-book-selection";

const book = (id: string) => ({ id, title: `Book ${id}` }) as LibraryBook;
const BOOKS = [book("1"), book("2")];

const platform = {
	capabilities: {
		canOpenLocalPaths: false,
		canRevealInFileManager: false,
		canCopyToClipboard: false,
	},
	fileOpener: { quickLook: none() },
} as unknown as PlatformAdapter;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Shows the books in the grid of a library, and selects the books of `ids`. */
const showBooks = (readOnly: boolean, ids: readonly string[]) => {
	useLibraryStore.setState({
		library: { readOnly } as Library,
		bookCache: {
			key: "",
			generation: 0,
			total: BOOKS.length,
			pages: new Map([[0, BOOKS]]),
			stale: new Set(),
		},
		staleBookSnapshot: null,
	});
	useBookSelectionStore.setState({
		selection: { ...emptySelection, ids: new Set(ids) },
	});
};

describe("bookCommands: Edit", () => {
	let deps: BookCommandDeps;

	beforeEach(() => {
		mocks.requestBooksEdit.mockClear();
		deps = { platform, editBook: vi.fn() };
	});

	it("is absent on a library that the person cannot edit", () => {
		showBooks(true, ["1", "2"]);
		expect(bookCommands(deps, 1)[BOOK_COMMAND.edit]).toBeUndefined();
		expect(bookCommands(deps, 2)[BOOK_COMMAND.edit]).toBeUndefined();
	});

	it("opens the sheet for more than one book", async () => {
		showBooks(false, ["1", "2"]);
		bookCommands(deps, 2)[BOOK_COMMAND.edit]?.();
		await flush();
		expect(mocks.requestBooksEdit).toHaveBeenCalledWith(BOOKS);
		expect(deps.editBook).not.toHaveBeenCalled();
	});

	it("opens the edit page for one book", async () => {
		showBooks(false, ["2"]);
		bookCommands(deps, 1)[BOOK_COMMAND.edit]?.();
		await flush();
		expect(deps.editBook).toHaveBeenCalledWith(BOOKS[1]);
		expect(mocks.requestBooksEdit).not.toHaveBeenCalled();
	});
});
