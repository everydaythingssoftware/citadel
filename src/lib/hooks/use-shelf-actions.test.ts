import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui", () => ({ toast: { show: vi.fn() } }));
vi.mock("@/stores/settings/actions", () => ({
	deleteSmartShelf: vi.fn(),
	renameSmartShelf: vi.fn(),
}));
vi.mock("@/stores/library-view/store", () => ({ useLibraryView: {} }));

import type { SmartShelf } from "@/lib/platform/settings/types";
import { deleteShelf, type ShelfActionDependencies } from "./use-shelf-actions";

const SHELF: SmartShelf = {
	id: "shelf-1",
	name: "Reading",
	filter: { query: "", sortOrder: "authorAz", hideRead: true },
};

const dependencies = (
	overrides: Partial<ShelfActionDependencies> = {},
): ShelfActionDependencies => ({
	remove: vi.fn(async () => {}),
	activeShelfId: () => null,
	resetToAllBooks: vi.fn(),
	report: vi.fn(),
	...overrides,
});

describe("deleteShelf", () => {
	it("deletes the shelf and leaves the view alone when another shelf shows", async () => {
		const deps = dependencies({ activeShelfId: () => "other" });
		await expect(deleteShelf(SHELF, deps)).resolves.toBe(true);
		expect(deps.remove).toHaveBeenCalledWith("shelf-1");
		expect(deps.resetToAllBooks).not.toHaveBeenCalled();
	});

	it("goes back to All Books when the deleted shelf was showing", async () => {
		const deps = dependencies({ activeShelfId: () => "shelf-1" });
		await deleteShelf(SHELF, deps);
		expect(deps.resetToAllBooks).toHaveBeenCalledOnce();
	});

	it("says what went wrong and keeps the view when deleting fails", async () => {
		const deps = dependencies({
			remove: vi.fn(async () => {
				throw new Error("Disk full");
			}),
			activeShelfId: () => "shelf-1",
		});
		await expect(deleteShelf(SHELF, deps)).resolves.toBe(false);
		expect(deps.report).toHaveBeenCalledWith(
			"Couldn’t delete “Reading”",
			"Disk full",
		);
		expect(deps.resetToAllBooks).not.toHaveBeenCalled();
	});
});
