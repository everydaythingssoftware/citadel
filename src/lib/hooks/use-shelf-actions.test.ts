import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	show: vi.fn(),
	deleteSmartShelf: vi.fn(async (_id: string) => {}),
	resetToAllBooks: vi.fn(),
	activeShelfId: null as string | null,
}));

vi.mock("@/components/ui", () => ({ toast: { show: mocks.show } }));
vi.mock("@/stores/settings/actions", () => ({
	deleteSmartShelf: mocks.deleteSmartShelf,
	renameSmartShelf: vi.fn(),
}));
vi.mock("@/stores/library-view/store", () => ({
	useLibraryView: {
		getState: () => ({
			activeShelfId: mocks.activeShelfId,
			resetToAllBooks: mocks.resetToAllBooks,
		}),
	},
}));

import type { SmartShelf } from "@/lib/platform/settings/types";
import { deleteShelf } from "./use-shelf-actions";

const SHELF: SmartShelf = {
	id: "shelf-1",
	name: "Reading",
	filter: { query: "", sortOrder: "authorAz", hideRead: true },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteSmartShelf.mockImplementation(async () => {});
});

describe("deleteShelf", () => {
	it("deletes the shelf and leaves the view alone when another shelf shows", async () => {
		mocks.activeShelfId = "other";
		await deleteShelf(SHELF);
		expect(mocks.deleteSmartShelf).toHaveBeenCalledWith("shelf-1");
		expect(mocks.resetToAllBooks).not.toHaveBeenCalled();
	});

	it("goes back to All Books when the deleted shelf was showing", async () => {
		mocks.activeShelfId = "shelf-1";
		await deleteShelf(SHELF);
		expect(mocks.resetToAllBooks).toHaveBeenCalledOnce();
	});

	it("says what went wrong and keeps the view when deleting fails", async () => {
		mocks.activeShelfId = "shelf-1";
		mocks.deleteSmartShelf.mockImplementation(async () => {
			throw new Error("Disk full");
		});
		await deleteShelf(SHELF);
		expect(mocks.show).toHaveBeenCalledWith({
			title: "Couldn’t delete “Reading”",
			message: "Disk full",
		});
		expect(mocks.resetToAllBooks).not.toHaveBeenCalled();
	});
});
