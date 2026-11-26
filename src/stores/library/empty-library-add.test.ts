import type { Library, Options } from "@/lib/services/library";
import { describe, expect, it, vi } from "vitest";

const initClient = vi.fn<(options: Options) => Promise<Library>>();

vi.mock("@/lib/services/library-catalog", () => ({
	libraryCatalog: { open: (options: Options) => initClient(options) },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const book = (id: string) => ({ id, title: id, cover_image: null });

describe("a brand-new empty library", () => {
	it("shows the first books added to it in All Books", async () => {
		vi.resetModules();
		const { useLibraryStore } = await import("./store");
		const { ALL_BOOKS_FILTER, BOOK_PAGE_SIZE } = await import(
			"@/lib/book-page-cache"
		);

		// The backend's book list: empty at open, two books after the add.
		let books: ReturnType<typeof book>[] = [];
		const queryBooks = vi.fn(async (query: { limit: number | null }) => ({
			items: query.limit === 0 ? [] : books,
			total: books.length,
		}));
		const library = {
			queryBooks,
			listAuthors: vi.fn(async () => []),
			listSeries: vi.fn(async () => []),
			listCoverThumbnails: vi.fn(async () => []),
			warmCoverThumbnails: vi.fn(async () => []),
			ensureCoverThumbnails: vi.fn(async () => []),
		} as unknown as Library;
		initClient.mockResolvedValueOnce(library);

		const { actions } = useLibraryStore.getState();
		await actions.initialize("C:/Users/reader/Citadel");
		actions.setBookFilter(ALL_BOOKS_FILTER);
		// Books.tsx: the grid's padded range for an untouched viewport.
		await actions.ensureBookRange(-BOOK_PAGE_SIZE, BOOK_PAGE_SIZE);
		expect(useLibraryStore.getState().bookCache.total).toBe(0);

		// Add Book... lands two books, then the upload queue invalidates.
		books = [book("1"), book("2")];
		actions.invalidateBooks();
		await flush();
		// Books.tsx refetches the viewport when the generation moves.
		await actions.ensureBookRange(-BOOK_PAGE_SIZE, BOOK_PAGE_SIZE);
		await flush();

		const state = useLibraryStore.getState();
		expect(state.libraryTotal).toBe(2);
		expect(state.bookCache.total).toBe(2);
	});
});
