import { ALL_BOOKS_FILTER } from "@/lib/book-page-cache";
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

type QueryPage = Awaited<ReturnType<Library["queryBooks"]>>;

/** An empty result page that carries hints with the given messages. */
const pageWith = (messages: string[], total = 0): QueryPage => ({
	items: [],
	total,
	search_hints: messages.map((message) => ({
		kind: "unknownField",
		name: "x",
		message,
	})),
});

const fakeLibrary = () => {
	const fake = {
		listCustomColumns: vi.fn(async () => []),
		getCustomValuesForBook: vi.fn(async (_id: string) => []),
		setCustomValue: vi.fn(
			async (_id: string, _column: number, _value: unknown) => undefined,
		),
		addBookGenres: vi.fn(async (_id: string, _genres: string[]) => undefined),
		setBookCoverFromMetadata: vi.fn(
			async (_id: string, _coverId: string) => undefined,
		),
		setBookCoverFromFile: vi.fn(async (_id: string, _image: Blob) => undefined),
		queryBooks: vi.fn(async (): Promise<QueryPage> => pageWith([], 250)),
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

describe("library open", () => {
	beforeEach(() => {
		initClient.mockReset();
	});

	it("logs a failed library total and a failed cover index", async () => {
		const { useLibraryStore } = await importStore();
		const a = fakeLibrary();
		const totalFailure = new Error("Library busy");
		const thumbFailure = new Error("Cover index failed");
		a.fake.queryBooks.mockImplementation(async (...args: unknown[]) => {
			const [query] = args as [{ limit?: number | null }];
			if (query.limit === 0) throw totalFailure;
			return pageWith([], 250);
		});
		a.fake.listCoverThumbnails.mockRejectedValueOnce(thumbFailure);
		initClient.mockResolvedValueOnce(a.library);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await useLibraryStore.getState().actions.initialize(PATH_A);
		expect(log).toHaveBeenCalledWith(
			"Failed to load library total:",
			totalFailure,
		);
		expect(log).toHaveBeenCalledWith(
			"Failed to load cover thumbnails:",
			thumbFailure,
		);
		log.mockRestore();
	});
});

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

describe("setBooksRead", () => {
	beforeEach(() => {
		initClient.mockReset();
	});

	it("writes every book and refreshes the grid once", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const before = useLibraryStore.getState().bookCache.generation;

		await useLibraryStore
			.getState()
			.actions.setBooksRead(["1", "2", "3"], true);

		expect(a.fake.updateBook).toHaveBeenCalledTimes(3);
		expect(a.fake.updateBook).toHaveBeenCalledWith(
			"2",
			expect.objectContaining({ is_read: true, title: null }),
		);
		expect(useLibraryStore.getState().bookCache.generation).toBe(before + 1);
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
			() => actions.setBookCoverFromMetadata("1", "cover-1"),
		])
			await expect(operation()).rejects.toThrow("switch is in progress");
		for (const method of [
			a.fake.listCustomColumns,
			a.fake.getCustomValuesForBook,
			a.fake.setCustomValue,
			a.fake.addBookGenres,
			a.fake.setBookCoverFromMetadata,
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
			() => actions.setBookCoverFromMetadata("1", "cover-1"),
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
		a.fake.setBookCoverFromMetadata.mockReturnValueOnce(cover.promise);
		const { actions } = useLibraryStore.getState();
		const read = actions.getCustomValuesForBook("1");
		const write = actions.setBookCoverFromMetadata("1", "cover-1");
		const b = fakeLibrary();
		initClient.mockResolvedValueOnce(b.library);
		await actions.initialize(PATH_B);
		const generation = useLibraryStore.getState().bookCache.generation;
		fields.resolve([]);
		cover.resolve(undefined);
		await expect(read).rejects.toThrow("Library changed");
		await expect(write).rejects.toThrow("Library changed");
		expect(useLibraryStore.getState().bookCache.generation).toBe(generation);
		expect(b.fake.setBookCoverFromMetadata).not.toHaveBeenCalled();
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

describe("search feedback", () => {
	beforeEach(() => {
		initClient.mockReset();
	});

	const bootWithSnapshot = async () => {
		const booted = await bootOnA();
		const { actions } = booted.useLibraryStore.getState();
		// The boot already holds page 0 of ALL_BOOKS_FILTER, so a seed search
		// makes the snapshot.
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "seed" });
		await actions.ensureBookRange(0, 10);
		// The store module was reset, so the error class and the helpers must
		// come from the same reset.
		const { InvalidSearchError } = await import("@/lib/services/library/types");
		const feedback = await import("@/lib/book-grid-view");
		const currentKey = () => booted.useLibraryStore.getState().bookCache.key;
		const shownFeedback = () => {
			const state = booted.useLibraryStore.getState();
			return feedback.bookGridView({
				libraryReady: true,
				cache: state.bookCache,
				staleSnapshot: state.staleBookSnapshot,
				pageOutcome: state.pageOutcome,
				libraryTotal: state.libraryTotal,
				selectedCount: 0,
			}).callout;
		};
		return {
			...booted,
			InvalidSearchError,
			feedback,
			currentKey,
			shownFeedback,
		};
	};

	it("a search that does not parse shows the error and keeps the last results", async () => {
		const {
			useLibraryStore,
			a,
			InvalidSearchError,
			currentKey,
			shownFeedback,
		} = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError("Missing closing quote."),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		await actions.ensureBookRange(0, 10);
		const state = useLibraryStore.getState();
		expect(state.pageOutcome).toEqual({
			key: currentKey(),
			kind: "searchError",
			message: "Missing closing quote.",
		});
		expect(shownFeedback()).toEqual({
			tone: "error",
			text: "Missing closing quote.",
		});
		expect(state.staleBookSnapshot).not.toBeNull();
	});

	it("the first search error after the boot keeps the books of the boot", async () => {
		const { useLibraryStore, a } = await bootOnA();
		const { InvalidSearchError } = await import("@/lib/services/library/types");
		const { actions } = useLibraryStore.getState();
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError('Type a value after "tags:".'),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "tags:" });
		await actions.ensureBookRange(0, 10);
		expect(useLibraryStore.getState().staleBookSnapshot?.total).toBe(250);
	});

	it("a key with a search error sends no more page requests", async () => {
		const { useLibraryStore, a, InvalidSearchError } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError("Missing closing quote."),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		await actions.ensureBookRange(0, 10);
		const calls = a.fake.queryBooks.mock.calls.length;
		await actions.ensureBookRange(500, 700);
		expect(a.fake.queryBooks.mock.calls.length).toBe(calls);
	});

	it("a load error lets the next range request fetch the page again", async () => {
		const { useLibraryStore, a } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		a.fake.queryBooks.mockRejectedValueOnce(new Error("Disk failed"));
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		await actions.ensureBookRange(0, 10);
		expect(useLibraryStore.getState().pageOutcome?.kind).toBe("loadError");
		const calls = a.fake.queryBooks.mock.calls.length;
		await actions.ensureBookRange(0, 10);
		expect(a.fake.queryBooks.mock.calls.length).toBe(calls + 1);
		expect(useLibraryStore.getState().pageOutcome?.kind).toBe("ok");
		log.mockRestore();
	});

	it("a failed search after a change of the view drops the last results", async () => {
		const { useLibraryStore, a, InvalidSearchError } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError("Missing closing quote."),
		);
		actions.setBookFilter({
			...ALL_BOOKS_FILTER,
			text: 'tags:"x',
			authorId: "7",
		});
		await actions.ensureBookRange(0, 10);
		expect(useLibraryStore.getState().staleBookSnapshot).toBeNull();
	});

	it("the last answer stays while the next search is in flight", async () => {
		const { useLibraryStore, a, InvalidSearchError, feedback, currentKey } =
			await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError("Missing closing quote."),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		await actions.ensureBookRange(0, 10);
		const next = deferred<QueryPage>();
		a.fake.queryBooks.mockReturnValueOnce(next.promise);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x"' });
		const range = actions.ensureBookRange(0, 10);
		const { pageOutcome } = useLibraryStore.getState();
		expect(pageOutcome?.kind).toBe("searchError");
		expect(feedback.outcomeFor(pageOutcome, currentKey())).toBeNull();
		next.resolve(pageWith([]));
		await range;
		expect(useLibraryStore.getState().pageOutcome).toEqual({
			key: currentKey(),
			kind: "ok",
			hints: [],
		});
	});

	it("a hint shows with the results and clears on the next clean search", async () => {
		const { useLibraryStore, a, shownFeedback } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		a.fake.queryBooks.mockResolvedValueOnce(
			pageWith(['No field named "titel". Searched as text.']),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "titel:dune" });
		await actions.ensureBookRange(0, 10);
		expect(shownFeedback()).toEqual({
			tone: "hint",
			text: 'No field named "titel". Searched as text.',
		});
		a.fake.queryBooks.mockResolvedValueOnce(pageWith([]));
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		await actions.ensureBookRange(0, 10);
		expect(shownFeedback()).toBeNull();
	});

	it("a late failure for an older search does not replace the current answer", async () => {
		const { useLibraryStore, a, InvalidSearchError, currentKey } =
			await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const first = deferred<QueryPage>();
		const second = deferred<QueryPage>();
		a.fake.queryBooks
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "a" });
		const firstRange = actions.ensureBookRange(0, 10);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "b" });
		const secondRange = actions.ensureBookRange(0, 10);
		second.resolve(pageWith([]));
		await secondRange;
		first.reject(new InvalidSearchError("Missing closing quote."));
		await firstRange;
		expect(useLibraryStore.getState().pageOutcome).toEqual({
			key: currentKey(),
			kind: "ok",
			hints: [],
		});
	});

	it("a late hint after a change of the scope does not replace the current answer", async () => {
		const { useLibraryStore, a, shownFeedback } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const first = deferred<QueryPage>();
		const second = deferred<QueryPage>();
		a.fake.queryBooks
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "a" });
		const firstRange = actions.ensureBookRange(0, 10);
		actions.setBookFilter({
			...ALL_BOOKS_FILTER,
			text: "a",
			searchScope: "allFields",
		});
		const secondRange = actions.ensureBookRange(0, 10);
		second.resolve(pageWith(["current hint"]));
		await secondRange;
		first.resolve(pageWith(["old hint"]));
		await firstRange;
		expect(shownFeedback()).toEqual({ tone: "hint", text: "current hint" });
	});

	it("a load error goes to the outcome and to the log, not to the callout", async () => {
		const {
			useLibraryStore,
			a,
			InvalidSearchError,
			currentKey,
			shownFeedback,
		} = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError("Missing closing quote."),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		await actions.ensureBookRange(0, 10);
		const failure = new Error("Disk failed");
		a.fake.queryBooks.mockRejectedValueOnce(failure);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		await actions.ensureBookRange(0, 10);
		expect(useLibraryStore.getState().pageOutcome).toEqual({
			key: currentKey(),
			kind: "loadError",
			message: "Disk failed",
			hints: [],
			failedPages: [0],
		});
		expect(shownFeedback()).toBeNull();
		expect(log).toHaveBeenCalledWith("Failed to load books:", failure);
		log.mockRestore();
	});

	it("a later page that loads keeps the load error of an earlier page", async () => {
		const { useLibraryStore, a } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const firstPage = deferred<QueryPage>();
		const secondPage = deferred<QueryPage>();
		a.fake.queryBooks
			.mockImplementationOnce(() => firstPage.promise)
			.mockImplementationOnce(() => secondPage.promise);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		const loading = actions.ensureBookRange(0, 150);
		firstPage.reject(new Error("Library busy"));
		await vi.waitFor(() =>
			expect(useLibraryStore.getState().pageOutcome?.kind).toBe("loadError"),
		);
		secondPage.resolve(pageWith([], 250));
		await loading;
		expect(useLibraryStore.getState().pageOutcome).toMatchObject({
			kind: "loadError",
			message: "Library busy",
			failedPages: [0],
		});
		log.mockRestore();
	});

	it("a search error replaces an older load error", async () => {
		const { useLibraryStore, a, InvalidSearchError } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		a.fake.queryBooks.mockRejectedValueOnce(new Error("Disk failed"));
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		await actions.ensureBookRange(0, 10);
		a.fake.queryBooks.mockRejectedValueOnce(
			new InvalidSearchError("Missing closing quote."),
		);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		await actions.ensureBookRange(0, 10);
		expect(useLibraryStore.getState().pageOutcome?.kind).toBe("searchError");
		log.mockRestore();
	});

	it("a library switch drops the answer when the filter changed during the load", async () => {
		const { useLibraryStore, InvalidSearchError } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		const b = fakeLibrary();
		const gate = deferred<QueryPage>();
		b.fake.queryBooks.mockImplementation((async (query: {
			text: string | null;
		}) => {
			if (query.text) {
				await gate.promise;
				throw new InvalidSearchError("Missing closing quote.");
			}
			return pageWith([], 250);
		}) as never);
		initClient.mockResolvedValueOnce(b.library);
		const switching = actions.initialize(PATH_B);
		await flush();
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		gate.resolve(pageWith([]));
		await switching;
		const state = useLibraryStore.getState();
		expect(state.confirmedLibraryPath).toBe(PATH_B);
		expect(state.pageOutcome).toBeNull();
	});

	it("a library switch with bad search text shows the callout", async () => {
		const { useLibraryStore, InvalidSearchError, shownFeedback } =
			await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: 'tags:"x' });
		const b = fakeLibrary();
		b.fake.queryBooks.mockImplementation((async (query: {
			text: string | null;
		}) => {
			if (query.text) throw new InvalidSearchError("Missing closing quote.");
			return pageWith([], 250);
		}) as never);
		initClient.mockResolvedValueOnce(b.library);
		await actions.initialize(PATH_B);
		expect(useLibraryStore.getState().confirmedLibraryPath).toBe(PATH_B);
		expect(shownFeedback()).toEqual({
			tone: "error",
			text: "Missing closing quote.",
		});
	});

	it("a library switch with a load error logs it and keeps it out of the callout", async () => {
		const { useLibraryStore, shownFeedback } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "dune" });
		const failure = new Error("Disk failed");
		const b = fakeLibrary();
		b.fake.queryBooks.mockImplementation((async (query: {
			text: string | null;
		}) => {
			if (query.text) throw failure;
			return pageWith([], 250);
		}) as never);
		initClient.mockResolvedValueOnce(b.library);
		await actions.initialize(PATH_B);
		expect(useLibraryStore.getState().confirmedLibraryPath).toBe(PATH_B);
		expect(useLibraryStore.getState().pageOutcome?.kind).toBe("loadError");
		expect(shownFeedback()).toBeNull();
		expect(log).toHaveBeenCalledWith("Failed to load books:", failure);
		log.mockRestore();
	});

	it("a library switch with a hinted search text shows the hint", async () => {
		const { useLibraryStore, shownFeedback } = await bootWithSnapshot();
		const { actions } = useLibraryStore.getState();
		actions.setBookFilter({ ...ALL_BOOKS_FILTER, text: "titel:x" });
		const b = fakeLibrary();
		b.fake.queryBooks.mockImplementation((async (query: {
			text: string | null;
		}) =>
			query.text
				? pageWith(['No field named "titel". Searched as text.'], 1)
				: pageWith([], 250)) as never);
		initClient.mockResolvedValueOnce(b.library);
		await actions.initialize(PATH_B);
		expect(shownFeedback()).toEqual({
			tone: "hint",
			text: 'No field named "titel". Searched as text.',
		});
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
			search_hints: [],
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
