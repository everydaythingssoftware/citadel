import { booksTitle, formatCount } from "@/lib/book-count";

export const BOOK_COMMAND = {
	showDetails: "book-show-details",
	open: "book-open",
	edit: "book-edit",
	quickLook: "book-quick-look",
	toggleFinished: "book-mark-finished",
	showInFileManager: "book-show-in-file-manager",
	copyTitle: "book-copy-title",
	download: "book-download",
	delete: "book-delete",
} as const;

export type TBookCommand = (typeof BOOK_COMMAND)[keyof typeof BOOK_COMMAND];

/** What the selection and platform allow, for the book menus. */
export interface BookMenuContext {
	selectedCount: number;
	allFinished: boolean;
	/** Books open in their default app (the desktop). */
	canOpen: boolean;
	/** The library can be changed (not read-only). */
	canEdit: boolean;
	canQuickLook: boolean;
	canShowInFileManager: boolean;
	/** "Finder", "File Explorer" or "File Manager". */
	fileManagerName: string;
	canCopyTitle: boolean;
	/** Files download from the server (the web). */
	canDownload: boolean;
}

export type BookMenuEntry =
	| {
			type: "item";
			id: TBookCommand;
			label: string;
			destructive?: boolean;
	  }
	| { type: "separator"; id: string };

const item = (
	id: TBookCommand,
	label: string,
	destructive?: boolean,
): BookMenuEntry => ({
	type: "item",
	id,
	label,
	...(destructive ? { destructive } : {}),
});

/** "Mark as Finished", or "Mark as Unfinished" once every book is. */
export const finishedLabel = (allFinished: boolean): string =>
	allFinished ? "Mark as Unfinished" : "Mark as Finished";

export const openLabel = (count: number): string =>
	count === 1 ? "Open" : `Open ${booksTitle(count)}`;

export const deleteLabel = (count: number): string =>
	count === 1 ? "Delete…" : `Delete ${booksTitle(count)}…`;

export const copyTitleLabel = (count: number): string =>
	count === 1 ? "Copy Title" : `Copy ${formatCount(count)} Titles`;

/**
 * The book right-click menu, grouped. Items that don't apply to this
 * platform or to several books are left out rather than greyed out, and
 * separators only sit between groups that have items.
 */
export const bookMenuEntries = (context: BookMenuContext): BookMenuEntry[] => {
	const { selectedCount: count } = context;
	if (count === 0) return [];
	const single = count === 1;
	const groups: BookMenuEntry[][] = [
		[
			...(single ? [item(BOOK_COMMAND.showDetails, "Show Details")] : []),
			...(context.canOpen ? [item(BOOK_COMMAND.open, openLabel(count))] : []),
			...(single && context.canEdit ? [item(BOOK_COMMAND.edit, "Edit…")] : []),
			...(single && context.canQuickLook
				? [item(BOOK_COMMAND.quickLook, "Quick Look")]
				: []),
		],
		context.canEdit
			? [item(BOOK_COMMAND.toggleFinished, finishedLabel(context.allFinished))]
			: [],
		[
			...(single && context.canShowInFileManager
				? [
						item(
							BOOK_COMMAND.showInFileManager,
							`Show in ${context.fileManagerName}`,
						),
					]
				: []),
			...(context.canCopyTitle
				? [item(BOOK_COMMAND.copyTitle, copyTitleLabel(count))]
				: []),
			...(single && context.canDownload
				? [item(BOOK_COMMAND.download, "Download")]
				: []),
		],
		context.canEdit
			? [item(BOOK_COMMAND.delete, deleteLabel(count), true)]
			: [],
	];
	return groups
		.filter((group) => group.length > 0)
		.flatMap((group, index) =>
			index === 0
				? group
				: [{ type: "separator" as const, id: `separator-${index}` }, ...group],
		);
};
