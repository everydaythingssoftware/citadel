import {
	LibraryBookSortOrder,
	type LibraryBookSortOrderKey,
} from "@/stores/library-view/store";

/** The name of each sort order, as the sort menu shows it. */
export const SORT_LABELS: Record<LibraryBookSortOrderKey, string> = {
	nameAz: "Name (A–Z)",
	nameZa: "Name (Z–A)",
	authorAz: "Author (A–Z)",
	authorZa: "Author (Z–A)",
	addedNewest: "Recently added",
	addedOldest: "Oldest added",
};

export const librarySortOptions: {
	value: LibraryBookSortOrderKey;
	label: string;
}[] = (Object.keys(LibraryBookSortOrder) as LibraryBookSortOrderKey[]).map(
	(key) => ({
		value: key,
		label: SORT_LABELS[key],
	}),
);
