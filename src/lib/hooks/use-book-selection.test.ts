import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import { emptySelection, selectAll } from "@/lib/book-selection";
import { resolveSelectedBooks } from "@/lib/hooks/use-book-selection";
import { useBookSelectionStore } from "@/stores/book-selection/store";
import { useLibraryStore } from "@/stores/library/store";

const book = { id: "b0", title: "Dune" } as LibraryBook;

describe("resolveSelectedBooks", () => {
	it("refuses a selection whose books did not all load", async () => {
		// No library is open, so the missing pages cannot load.
		useLibraryStore.setState({
			bookCache: {
				key: "k",
				generation: 0,
				total: 300,
				pages: new Map([[0, [book]]]),
				stale: new Set(),
			},
			staleBookSnapshot: null,
		});
		useBookSelectionStore.setState({ selection: selectAll(emptySelection) });

		await expect(resolveSelectedBooks()).rejects.toThrow(
			"Some of the selected books did not load, so nothing changed.",
		);
	});
});
