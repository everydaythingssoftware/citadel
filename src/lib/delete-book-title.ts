import { booksTitle, formatCount } from "@/lib/book-count";
import { BookDeletion, type TBookDeletion } from "@/lib/services/library";

interface DeleteBookCopy {
	description: string;
	confirmLabel: string;
	failureTitle: string;
	failureDescription: string;
}

export const deleteBookCopy = (deletion: TBookDeletion): DeleteBookCopy =>
	deletion === BookDeletion.trash
		? {
				description:
					"This book will be removed from Citadel and its files moved to the Trash. You can recover the files, then re-import the book.",
				confirmLabel: "Move to Trash",
				failureTitle: "Book removed, files not moved to Trash",
				failureDescription:
					"The book was removed from your library, but its files could not be moved to the Trash. The files remain in your library folder at the locations below. You can move them manually or re-import them.",
			}
		: {
				description:
					"This book and its files will be deleted from the library. This can't be undone.",
				confirmLabel: "Delete Permanently",
				failureTitle: "Book removed, files not deleted",
				failureDescription:
					"The book was removed from the library, but some of its files could not be deleted. They remain in the library folder at the locations below.",
			};

export const deleteBookDialogTitle = (title: string): string => {
	const characters = Array.from(title);
	const displayTitle =
		characters.length > 60 ? `${characters.slice(0, 59).join("")}…` : title;
	return `Delete “${displayTitle}”?`;
};

/** The confirmation for deleting several books at once from the grid. */
export const deleteBooksCopy = (
	deletion: TBookDeletion,
	count: number,
): DeleteBookCopy => {
	if (count === 1) return deleteBookCopy(deletion);
	const books = `${formatCount(count)} books`;
	return deletion === BookDeletion.trash
		? {
				description: `These ${books} will be removed from Citadel and their files moved to the Trash. Other books in the library are not affected. You can recover the files, then re-import the books.`,
				confirmLabel: "Move to Trash",
				failureTitle: "Books removed, some files not moved to Trash",
				failureDescription:
					"The books were removed from your library, but some of their files could not be moved to the Trash. They remain in your library folder at the locations below. You can move them manually or re-import them.",
			}
		: {
				description: `These ${books} and their files will be deleted from the library. Other books are not affected. This can't be undone.`,
				confirmLabel: "Delete Permanently",
				failureTitle: "Books removed, some files not deleted",
				failureDescription:
					"The books were removed from the library, but some of their files could not be deleted. They remain in the library folder at the locations below.",
			};
};

/** “Delete “Middlemarch”?” for one book, “Delete 3 Books?” for several. */
export const deleteBooksDialogTitle = (titles: readonly string[]): string => {
	const [only] = titles;
	return titles.length === 1 && only !== undefined
		? deleteBookDialogTitle(only)
		: `Delete ${booksTitle(titles.length)}?`;
};
