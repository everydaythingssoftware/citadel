import { describe, expect, it } from "vitest";
import { librarySortOptions } from "./library-sort-options";

describe("librarySortOptions", () => {
	// Pins the user-visible labels and menu order, which the type system
	// (Record<LibraryBookSortOrderKey, string>) cannot guarantee.
	it("exposes the six sort orders with their labels, in menu order", () => {
		expect(librarySortOptions).toEqual([
			{ value: "nameAz", label: "Name (A–Z)" },
			{ value: "nameZa", label: "Name (Z–A)" },
			{ value: "authorAz", label: "Author (A–Z)" },
			{ value: "authorZa", label: "Author (Z–A)" },
			{ value: "addedNewest", label: "Recently added" },
			{ value: "addedOldest", label: "Oldest added" },
		]);
	});
});
