import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type LibraryBookQuery } from "@/bindings";
import { createTauriLibrary } from "./tauri";
import { InvalidSearchError } from "./types";

vi.mock("@/bindings", () => ({
	commands: { clbQueryBooks: vi.fn() },
}));

const query: LibraryBookQuery = {
	text: 'tags:"x',
	author_id: null,
	series_id: null,
	tag_id: null,
	publisher_id: null,
	hide_read: false,
	search_scope: "titlesAuthorsSeries",
	sort: "AuthorAsc",
	limit: 100,
	offset: 0,
};

describe("tauri library queryBooks", () => {
	beforeEach(() => {
		vi.mocked(commands.clbQueryBooks).mockReset();
	});

	it("throws InvalidSearchError for a search that does not parse", async () => {
		vi.mocked(commands.clbQueryBooks).mockResolvedValue({
			status: "error",
			error: { code: "invalidSearch", message: "Missing closing quote." },
		});
		const rejection = createTauriLibrary().queryBooks(query);
		await expect(rejection).rejects.toBeInstanceOf(InvalidSearchError);
		await expect(rejection).rejects.toThrow("Missing closing quote.");
	});

	it("keeps the text of an error that Tauri gives as a string", async () => {
		vi.mocked(commands.clbQueryBooks).mockResolvedValue({
			status: "error",
			error: "invalid args `query` for command `clb_query_books`" as never,
		});
		const rejection = createTauriLibrary().queryBooks(query);
		await expect(rejection).rejects.toThrow(
			"invalid args `query` for command `clb_query_books`",
		);
		await expect(rejection).rejects.not.toBeInstanceOf(InvalidSearchError);
	});

	it("throws a plain Error for any other code", async () => {
		vi.mocked(commands.clbQueryBooks).mockResolvedValue({
			status: "error",
			error: { code: "internal", message: "Failed" },
		});
		const rejection = createTauriLibrary().queryBooks(query);
		await expect(rejection).rejects.toThrow("Failed");
		await expect(rejection).rejects.not.toBeInstanceOf(InvalidSearchError);
	});
});
