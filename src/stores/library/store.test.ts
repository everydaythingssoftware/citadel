import type { Library, Options } from "@/lib/services/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const initClient = vi.fn<(options: Options) => Promise<Library>>();

vi.mock("@/lib/services/library-catalog", () => ({
	libraryCatalog: { open: (options: Options) => initClient(options) },
}));

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
		listCustomColumns: vi.fn(async () => []),
		getCustomValuesForBook: vi.fn(async (_id: string) => []),
		setCustomValue: vi.fn(
			async (_id: string, _column: number, _value: unknown) => undefined,
		),
		addBookGenres: vi.fn(async (_id: string, _genres: string[]) => undefined),
		setBookCoverFromUrl: vi.fn(async (_id: string, _url: string) => undefined),
		queryBooks: vi.fn(async () => ({ items: [], total: 250 })),
		listAuthors: vi.fn(async () => []),
		listSeries: vi.fn(async () => []),
		listCoverThumbnails: vi.fn(async () => []),
		warmCoverThumbnails: vi.fn(async () => []),
		ensureCoverThumbnails: vi.fn(async () => []),
		updateBook: vi.fn(async () => undefined),
		deleteBooks: vi.fn(async (ids: string[]) => ({
			deleted: ids.length,
			folder_failures: [] as string[],
		})),
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

describe("deleteBooks", () => {
	beforeEach(() => {
		initClient.mockReset();
	});

	it("preserves the visible book cache when deletion is rejected", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const before = useLibraryStore.getState();
		a.fake.deleteBooks.mockRejectedValueOnce(
			new Error("Unsafe book folder path"),
		);
		await expect(before.actions.deleteBooks(["1"])).rejects.toThrow(
			"Unsafe book folder path",
		);
		expect(useLibraryStore.getState().bookCache).toBe(before.bookCache);
		expect(useLibraryStore.getState().coverThumbs).toBe(before.coverThumbs);
	});

	it("refreshes removed records and returns file failures for the warning screen", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const failure = "/library/Author/Book: Permission denied";
		a.fake.deleteBooks.mockResolvedValueOnce({
			deleted: 1,
			folder_failures: [failure],
		});
		const before = useLibraryStore.getState().bookCache.generation;
		const result = await useLibraryStore.getState().actions.deleteBooks(["1"]);
		expect(result).toEqual({ deleted: 1, folder_failures: [failure] });
		expect(useLibraryStore.getState().bookCache.generation).toBeGreaterThan(
			before,
		);
	});

	it("deletes through the library, drops cover thumbs and invalidates the cache", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const thumb = { book_id: "1" } as never;
		useLibraryStore.setState({
			coverThumbs: new Map([
				["1", thumb],
				["2", thumb],
			]),
		});
		const generationBefore = useLibraryStore.getState().bookCache.generation;

		const outcome = await useLibraryStore.getState().actions.deleteBooks(["1"]);

		expect(a.fake.deleteBooks).toHaveBeenCalledWith(["1"]);
		expect(outcome).toEqual({ deleted: 1, folder_failures: [] });
		expect([...useLibraryStore.getState().coverThumbs.keys()]).toEqual(["2"]);
		expect(useLibraryStore.getState().bookCache.generation).toBeGreaterThan(
			generationBefore,
		);
	});
});

describe("selected-library custom fields, genres and covers", () => {
	beforeEach(() => {
		initClient.mockReset();
	});
	it("guards all five entry points while a switch diverts the backend", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const openB = deferred<Library>();
		initClient.mockReturnValueOnce(openB.promise);
		const { actions } = useLibraryStore.getState();
		const switching = actions.initialize(PATH_B);
		for (const operation of [
			() => actions.listCustomColumns(),
			() => actions.getCustomValuesForBook("1"),
			() => actions.setCustomValue("1", 1, null),
			() => actions.addBookGenres("1", ["Fantasy"]),
			() => actions.setBookCoverFromUrl("1", "https://example.test/cover.jpg"),
		])
			await expect(operation()).rejects.toThrow("switch is in progress");
		for (const method of [
			a.fake.listCustomColumns,
			a.fake.getCustomValuesForBook,
			a.fake.setCustomValue,
			a.fake.addBookGenres,
			a.fake.setBookCoverFromUrl,
		])
			expect(method).not.toHaveBeenCalled();
		openB.resolve(fakeLibrary().library);
		await switching;
	});
	it("invalidates after successful writes and preserves caches on failure", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const { actions } = useLibraryStore.getState();
		for (const operation of [
			() => actions.setCustomValue("1", 1, null),
			() => actions.addBookGenres("1", ["Fantasy"]),
			() => actions.setBookCoverFromUrl("1", "https://example.test/cover.jpg"),
		]) {
			const generation = useLibraryStore.getState().bookCache.generation;
			await operation();
			expect(useLibraryStore.getState().bookCache.generation).toBeGreaterThan(
				generation,
			);
		}
		a.fake.setCustomValue.mockRejectedValueOnce(new Error("invalid field"));
		const generation = useLibraryStore.getState().bookCache.generation;
		await expect(actions.setCustomValue("1", 1, null)).rejects.toThrow(
			"invalid field",
		);
		expect(useLibraryStore.getState().bookCache.generation).toBe(generation);
	});
	it("discards stale reads and mutation completions after a library switch", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const fields = deferred<[]>();
		const cover = deferred<undefined>();
		a.fake.getCustomValuesForBook.mockReturnValueOnce(fields.promise);
		a.fake.setBookCoverFromUrl.mockReturnValueOnce(cover.promise);
		const { actions } = useLibraryStore.getState();
		const read = actions.getCustomValuesForBook("1");
		const write = actions.setBookCoverFromUrl(
			"1",
			"https://example.test/cover.jpg",
		);
		const b = fakeLibrary();
		initClient.mockResolvedValueOnce(b.library);
		await actions.initialize(PATH_B);
		const generation = useLibraryStore.getState().bookCache.generation;
		fields.resolve([]);
		cover.resolve(undefined);
		await expect(read).rejects.toThrow("Library changed");
		await expect(write).rejects.toThrow("Library changed");
		expect(useLibraryStore.getState().bookCache.generation).toBe(generation);
		expect(b.fake.setBookCoverFromUrl).not.toHaveBeenCalled();
	});
});

describe("remote library initialization", () => {
	it("opens remote options without turning the server URL into a local filesystem path", async () => {
		initClient.mockReset();
		const { useLibraryStore, LibraryState } = await importStore();
		const remote = fakeLibrary();
		initClient.mockResolvedValueOnce(remote.library);
		const options: Options = {
			libraryType: "calibre",
			connectionType: "remote",
			url: "https://citadel.example",
		};
		await useLibraryStore.getState().actions.initialize(options);
		expect(initClient).toHaveBeenCalledWith(options);
		expect(useLibraryStore.getState().libraryState).toBe(LibraryState.ready);
		expect(useLibraryStore.getState().library).toBe(remote.library);
		expect(remote.fake.queryBooks).toHaveBeenCalled();
	});
});

describe("initial browser thumbnails", () => {
	it("requests thumbnails for covers in the page inserted during initialization", async () => {
		initClient.mockReset();
		const { useLibraryStore } = await importStore();
		const remote = fakeLibrary();
		const book = {
			id: "7",
			cover_image: {
				kind: "Remote",
				local_path: null,
				url: "https://citadel.example/api/books/7/cover",
			},
		};
		remote.fake.queryBooks.mockResolvedValue({
			items: [book] as never[],
			total: 1,
		});
		initClient.mockResolvedValueOnce(remote.library);
		await useLibraryStore.getState().actions.initialize({
			libraryType: "calibre",
			connectionType: "remote",
			url: "https://citadel.example",
		});
		expect(remote.fake.ensureCoverThumbnails).toHaveBeenCalledWith(["7"]);
	});
});
