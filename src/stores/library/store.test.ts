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
		queryBooks: vi.fn(async () => ({ items: [], total: 250 })),
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
