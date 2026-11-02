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
