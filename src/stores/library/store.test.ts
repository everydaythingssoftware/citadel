import type { BookUpdate, LibraryBook } from "@/bindings";
import type { Library, Options } from "@/lib/services/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const initClient = vi.fn<(options: Options) => Promise<Library>>();

vi.mock("@/lib/services/library", () => ({
	initClient: (options: Options) => initClient(options),
}));
vi.mock("@/bindings", () => ({ commands: {} }));

const PATH_A = "/Users/reader/Library A";
const PATH_B = "/Users/reader/Library B";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const openedPaths = () =>
	initClient.mock.calls.map(([options]) =>
		options.connectionType === "local" ? options.libraryPath : null,
	);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const fakeLibrary = () => {
	const fake = {
		queryBooks: vi.fn(async () => ({ items: [] as LibraryBook[], total: 250 })),
		listAuthors: vi.fn(async () => []),
		listSeries: vi.fn(async () => []),
		listCoverThumbnails: vi.fn(async () => []),
		warmCoverThumbnails: vi.fn(async () => []),
		ensureCoverThumbnails: vi.fn(async () => []),
		updateBook: vi.fn(async () => undefined),
	};
	return { fake, library: fake as unknown as Library };
};

/** Fresh store module per test: the switch machinery lives in module scope. */
const importStore = async () => {
	vi.resetModules();
	return import("./store");
};

/** Boots the store on library A and returns it ready, with A confirmed. */
const bootOnA = async () => {
	const { useLibraryStore } = await importStore();
	const a = fakeLibrary();
	initClient.mockResolvedValueOnce(a.library);
	await useLibraryStore.getState().actions.initialize(PATH_A);
	expect(useLibraryStore.getState().confirmedLibraryPath).toBe(PATH_A);
	return { useLibraryStore, a };
};

describe("library switch backend restore", () => {
	beforeEach(() => {
		initClient.mockReset();
	});

	it("a cancelled switch refuses reads and writes until the backend is restored", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const { actions } = useLibraryStore.getState();

		const openB = deferred<Library>();
		const restoreA = deferred<Library>();
		initClient
			.mockReturnValueOnce(openB.promise)
			.mockReturnValueOnce(restoreA.promise);

		void actions.initialize(PATH_B);
		void actions.initialize(PATH_A);
		// The superseded shadow's open lands: the backend now points at B.
		openB.resolve(fakeLibrary().library);
		await flush();

		const queriesBefore = a.fake.queryBooks.mock.calls.length;
		const generationBefore = useLibraryStore.getState().bookCache.generation;
		await actions.ensureBookRange(0, 150);
		await expect(actions.updateBook("1", {} as never)).rejects.toThrow(
			"A library switch is in progress",
		);
		expect(a.fake.queryBooks.mock.calls.length).toBe(queriesBefore);
		expect(a.fake.updateBook).not.toHaveBeenCalled();

		restoreA.resolve(a.library);
		await flush();

		expect(openedPaths()).toEqual([PATH_A, PATH_B, PATH_A]);
		expect(useLibraryStore.getState().bookCache.generation).toBe(
			generationBefore + 1,
		);
		await actions.updateBook("1", {} as never);
		expect(a.fake.updateBook).toHaveBeenCalledOnce();
	});

	it("a failed switch restores the confirmed backend even when the open rejects", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const { actions } = useLibraryStore.getState();

		const restoreA = deferred<Library>();
		initClient
			.mockRejectedValueOnce(new Error("Failed to allow library dir"))
			.mockReturnValueOnce(restoreA.promise);

		await actions.initialize(PATH_B);
		await flush();

		const state = useLibraryStore.getState();
		expect(state.confirmedLibraryPath).toBe(PATH_A);
		expect(state.libraryError?.message).toBe("Failed to allow library dir");
		expect(openedPaths().at(-1)).toBe(PATH_A);
		await expect(actions.updateBook("1", {} as never)).rejects.toThrow(
			"A library switch is in progress",
		);

		restoreA.resolve(a.library);
		await flush();

		await actions.updateBook("1", {} as never);
		expect(a.fake.updateBook).toHaveBeenCalledOnce();
	});
});

const libraryBook = (
	id: string,
	extra: Partial<LibraryBook> = {},
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
	language_list: [],
	...extra,
});

const noChanges: BookUpdate = {
	author_id_list: null,
	tag_list: null,
	title: null,
	timestamp: null,
	publication_date: null,
	is_read: null,
	description: null,
	series: null,
	series_index: null,
	language_list: null,
};

/** Boots on A with page 0 = books 1..3 loaded into the grid cache. */
const bootWithFirstPage = async () => {
	const booted = await bootOnA();
	const books = ["1", "2", "3"].map((id) => libraryBook(id));
	booted.a.fake.queryBooks.mockImplementation(async () => ({
		items: books,
		total: books.length,
	}));
	// Boot already landed an empty page 0; drop it so the fixtures load.
	booted.useLibraryStore.getState().actions.invalidateBooks();
	await booted.useLibraryStore.getState().actions.ensureBookRange(0, 50);
	await flush();
	expect(booted.useLibraryStore.getState().bookCache.pages.get(0)).toHaveLength(
		3,
	);
	return booted;
};

const cachedTitle = (
	state: { bookCache: { pages: ReadonlyMap<number, LibraryBook[]> } },
	id: string,
) => state.bookCache.pages.get(0)?.find((book) => book.id === id)?.title;

describe("selective book updates", () => {
	beforeEach(() => {
		initClient.mockReset();
	});

	it("patches the saved book in place from the server's copy, without refetching pages", async () => {
		const { useLibraryStore, a } = await bootWithFirstPage();
		const saved = libraryBook("2", { title: "Server Title", tag_list: ["sf"] });
		a.fake.updateBook.mockResolvedValueOnce(saved as never);
		const generation = useLibraryStore.getState().bookCache.generation;
		const queries = a.fake.queryBooks.mock.calls.length;

		const result = await useLibraryStore
			.getState()
			.actions.updateBook("2", { ...noChanges, tag_list: ["sf"] });

		const state = useLibraryStore.getState();
		expect(result).toEqual(saved);
		expect(state.bookCache.generation).toBe(generation);
		expect(state.bookCache.pages.get(0)?.[1]).toEqual(saved);
		expect(cachedTitle(state, "1")).toBe("Book 1");
		expect(a.fake.queryBooks.mock.calls.length).toBe(queries);
	});

	it("renders the edit before the server answers and rolls back on failure", async () => {
		const { useLibraryStore, a } = await bootWithFirstPage();
		const write = deferred<LibraryBook>();
		a.fake.updateBook.mockReturnValueOnce(write.promise as never);

		const pending = useLibraryStore
			.getState()
			.actions.updateBook("2", { ...noChanges, title: "Optimistic" });
		expect(cachedTitle(useLibraryStore.getState(), "2")).toBe("Optimistic");

		write.reject(new Error("disk full"));
		await expect(pending).rejects.toThrow("disk full");
		expect(cachedTitle(useLibraryStore.getState(), "2")).toBe("Book 2");
	});

	it("does not roll back over a newer edit of the same book", async () => {
		const { useLibraryStore, a } = await bootWithFirstPage();
		const first = deferred<LibraryBook>();
		const second = deferred<LibraryBook>();
		a.fake.updateBook
			.mockReturnValueOnce(first.promise as never)
			.mockReturnValueOnce(second.promise as never);
		const { actions } = useLibraryStore.getState();

		const firstSave = actions.updateBook("2", { ...noChanges, title: "First" });
		const secondSave = actions.updateBook("2", {
			...noChanges,
			title: "Second",
		});
		first.reject(new Error("conflict"));
		await expect(firstSave).rejects.toThrow("conflict");
		expect(cachedTitle(useLibraryStore.getState(), "2")).toBe("Second");

		second.resolve(libraryBook("2", { title: "Second" }));
		await secondSave;
		expect(cachedTitle(useLibraryStore.getState(), "2")).toBe("Second");
	});

	it("refetches pages when the edit can move the book under the current sort", async () => {
		const { useLibraryStore, a } = await bootWithFirstPage();
		const { actions } = useLibraryStore.getState();
		actions.setBookFilter({
			...useLibraryStore.getState().bookFilter,
			sortOrder: "nameAz",
		});
		await actions.ensureBookRange(0, 50);
		const generation = useLibraryStore.getState().bookCache.generation;
		a.fake.updateBook.mockResolvedValueOnce(
			libraryBook("2", { title: "Aardvark" }) as never,
		);

		await actions.updateBook("2", { ...noChanges, title: "Aardvark" });

		const state = useLibraryStore.getState();
		expect(state.bookCache.generation).toBe(generation + 1);
		expect(state.bookCache.pages.size).toBe(0);
	});

	it("refetches pages when the book was never loaded", async () => {
		const { useLibraryStore, a } = await bootWithFirstPage();
		const generation = useLibraryStore.getState().bookCache.generation;
		a.fake.updateBook.mockResolvedValueOnce(libraryBook("99") as never);

		await useLibraryStore
			.getState()
			.actions.updateBook("99", { ...noChanges, description: "x" });

		expect(useLibraryStore.getState().bookCache.generation).toBe(
			generation + 1,
		);
	});

	it("refreshes series counts when the series changes, without touching pages", async () => {
		const { useLibraryStore, a } = await bootWithFirstPage();
		const generation = useLibraryStore.getState().bookCache.generation;
		const seriesLoads = a.fake.listSeries.mock.calls.length;
		const authorLoads = a.fake.listAuthors.mock.calls.length;
		a.fake.updateBook.mockResolvedValueOnce(
			libraryBook("2", { series: "Saga", series_index: 1 }) as never,
		);

		await useLibraryStore
			.getState()
			.actions.updateBook("2", { ...noChanges, series: "Saga" });

		expect(useLibraryStore.getState().bookCache.generation).toBe(generation);
		expect(a.fake.listSeries.mock.calls.length).toBe(seriesLoads + 1);
		expect(a.fake.listAuthors.mock.calls.length).toBe(authorLoads);
	});
});
