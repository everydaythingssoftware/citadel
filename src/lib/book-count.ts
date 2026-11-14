const numberFormat = new Intl.NumberFormat("en-US");

export const formatCount = (count: number): string =>
	numberFormat.format(count);

/** "1 book", "2 books", "1,204 books". */
export const pluralize = (
	count: number,
	singular: string,
	plural = `${singular}s`,
): string => `${formatCount(count)} ${count === 1 ? singular : plural}`;

/** "Book" or "2 Books", for title-case menu items and dialog titles. */
export const booksTitle = (count: number): string =>
	count === 1 ? "Book" : `${formatCount(count)} Books`;

export interface BookCountStatus {
	loading: boolean;
	/** Books matching the current filter; null until known. */
	total: number | null;
	/** Books in the whole library; null until known. */
	libraryTotal: number | null;
	selectedCount: number;
}

/** The status bar under the grid. */
export const bookCountStatus = ({
	loading,
	total,
	libraryTotal,
	selectedCount,
}: BookCountStatus): string => {
	if (loading || total === null) return "Loading books…";
	if (selectedCount > 1)
		return `${formatCount(selectedCount)} of ${formatCount(total)} selected`;
	if (libraryTotal === null || total === libraryTotal)
		return pluralize(total, "book");
	return `${formatCount(total)} of ${pluralize(libraryTotal, "book")}`;
};
