import type { LibraryAuthor, LibrarySeries } from "@/bindings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	state: {
		series: [] as LibrarySeries[],
		seriesLoading: true,
		authors: [] as LibraryAuthor[],
		authorsLoading: true,
		actions: {
			updateAuthor: vi.fn(async (_id: string, _updates: unknown) => {}),
			deleteAuthor: vi.fn(async (_id: string) => {}),
		},
	},
}));

vi.mock("@/stores/library/store", () => ({
	useLibraryStore: {
		getState: () => store.state,
		setState: (patch: Record<string, unknown>) =>
			Object.assign(store.state, patch),
	},
}));

import { getListScenario } from "./list-scenarios";

describe("list fixture lifecycle", () => {
	beforeEach(() => {
		store.state.series = [{ id: 7, name: "Original series", book_count: 2 }];
		store.state.seriesLoading = true;
		store.state.authors = [
			{
				id: "8",
				name: "Original author",
				sortable_name: "Original author",
				book_count: 3,
			},
		];
		store.state.authorsLoading = true;
		vi.clearAllMocks();
	});

	it("restores the exact Series data and loading state without changing Authors", () => {
		const original = { ...store.state };
		const restore = getListScenario("series").install(100_000, false);
		expect(store.state.series).toHaveLength(100_000);
		expect(store.state.seriesLoading).toBe(false);
		expect(store.state.authors).toBe(original.authors);
		restore();
		expect(store.state.series).toBe(original.series);
		expect(store.state.seriesLoading).toBe(original.seriesLoading);
	});

	it("blocks Author writes while fixtures are installed and restores the original actions", async () => {
		const original = { ...store.state };
		const restore = getListScenario("authors").install(12, false);
		try {
			await expect(store.state.actions.updateAuthor("1", {})).rejects.toThrow(
				"Fixture editing is disabled",
			);
			await expect(store.state.actions.deleteAuthor("1")).rejects.toThrow(
				"Fixture editing is disabled",
			);
			expect(original.actions.updateAuthor).not.toHaveBeenCalled();
			expect(original.actions.deleteAuthor).not.toHaveBeenCalled();
		} finally {
			restore();
		}
		expect(store.state.authors).toBe(original.authors);
		expect(store.state.authorsLoading).toBe(original.authorsLoading);
		expect(store.state.actions).toBe(original.actions);
	});
});
