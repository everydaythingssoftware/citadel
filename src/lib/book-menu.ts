import { revealLabel } from "@/lib/book-file-actions";
import { booksTitle, formatCount } from "@/lib/book-count";
import type {
	ContextMenuItemEntry,
	ContextMenuSeparatorEntry,
} from "@/lib/context-menu";

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

/** The commands this platform and selection support; the rest are absent. */
export type BookCommands = Partial<Record<TBookCommand, () => void>>;

export type BookMenuEntry =
	| (ContextMenuItemEntry & { id: TBookCommand })
	| ContextMenuSeparatorEntry;

interface BookMenuLabels {
	count: number;
	/** Every selected book is finished: offer "Mark as Unfinished". */
	allFinished: boolean;
	fileManagerName: string;
}

const labelFor = (
	command: TBookCommand,
	{ count, allFinished, fileManagerName }: BookMenuLabels,
): string => {
	const single = count === 1;
	switch (command) {
		case BOOK_COMMAND.showDetails:
			return "Show Details";
		case BOOK_COMMAND.open:
			return single ? "Open" : `Open ${booksTitle(count)}`;
		case BOOK_COMMAND.edit:
			return single ? "Edit…" : `Edit ${booksTitle(count)}…`;
		case BOOK_COMMAND.quickLook:
			return "Quick Look";
		case BOOK_COMMAND.toggleFinished:
			return allFinished ? "Mark as Unfinished" : "Mark as Finished";
		case BOOK_COMMAND.showInFileManager:
			return revealLabel(fileManagerName);
		case BOOK_COMMAND.copyTitle:
			return single ? "Copy Title" : `Copy ${formatCount(count)} Titles`;
		case BOOK_COMMAND.download:
			return "Download";
		case BOOK_COMMAND.delete:
			return single ? "Delete…" : `Delete ${booksTitle(count)}…`;
	}
};

const GROUPS: readonly (readonly TBookCommand[])[] = [
	[
		BOOK_COMMAND.showDetails,
		BOOK_COMMAND.open,
		BOOK_COMMAND.edit,
		BOOK_COMMAND.quickLook,
	],
	[BOOK_COMMAND.toggleFinished],
	[
		BOOK_COMMAND.showInFileManager,
		BOOK_COMMAND.copyTitle,
		BOOK_COMMAND.download,
	],
	[BOOK_COMMAND.delete],
];

/**
 * The book right-click menu, grouped: the commands present in `commands`,
 * with separators only between groups that have items.
 */
export const bookMenuEntries = (
	commands: BookCommands,
	labels: BookMenuLabels,
): BookMenuEntry[] =>
	GROUPS.map((group) =>
		group.flatMap((id): BookMenuEntry[] => {
			const onSelect = commands[id];
			if (onSelect === undefined) return [];
			return [
				{
					id,
					label: labelFor(id, labels),
					onSelect,
					...(id === BOOK_COMMAND.delete ? { destructive: true } : {}),
				},
			];
		}),
	)
		.filter((group) => group.length > 0)
		.flatMap((group, index) =>
			index === 0
				? group
				: [{ type: "separator" as const, id: `separator-${index}` }, ...group],
		);
