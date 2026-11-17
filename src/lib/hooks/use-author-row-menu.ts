import { useNavigate } from "@tanstack/react-router";
import type { LibraryAuthor } from "@/bindings";
import type { ContextMenuEntry } from "@/lib/context-menu";
import {
	type ContextMenuController,
	type ContextMenuOpenEvent,
	type ContextMenuTarget,
	keyboardMenuEvent,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { useLibraryStore } from "@/stores/library/store";

export interface AuthorRowMenu {
	menu: ContextMenuController;
	/** Right-click or the Menu key on a row's links opens its menu. */
	targetFor: (author: LibraryAuthor) => ContextMenuTarget;
}

/**
 * The author row's right-click menu: Show Books, Edit… and, for an author
 * with no books left, Delete Author…, in place of hover-only icons.
 */
export const useAuthorRowMenu = ({
	onEdit,
	onDelete,
}: {
	onEdit: (authorId: LibraryAuthor["id"]) => void;
	onDelete: (authorId: LibraryAuthor["id"]) => void;
}): AuthorRowMenu => {
	const navigate = useNavigate();
	const menu = useContextMenu();
	const canEdit = useLibraryStore((state) => state.library?.readOnly === false);

	const open = (
		event: ContextMenuOpenEvent,
		row: HTMLElement,
		author: LibraryAuthor,
	) => {
		const items: ContextMenuEntry[] = [
			{
				id: "show-books",
				label: "Show Books",
				onSelect: () =>
					void navigate({ to: "/", search: { author_id: author.id } }),
			},
			...(canEdit
				? [
						{ type: "separator" as const, id: "edit-group" },
						{ id: "edit", label: "Edit…", onSelect: () => onEdit(author.id) },
					]
				: []),
			...(canEdit && author.book_count === 0
				? [
						{ type: "separator" as const, id: "delete-group" },
						{
							id: "delete",
							label: "Delete Author…",
							destructive: true,
							onSelect: () => onDelete(author.id),
						},
					]
				: []),
		];
		// Focus goes back to the row's link; the row itself isn't focusable.
		menu.returnFocusRef.current = row.querySelector("a");
		menu.openAt(event, items, author.name);
	};

	const targetFor = (author: LibraryAuthor): ContextMenuTarget => ({
		onContextMenu: (event) => open(event, event.currentTarget, author),
		onKeyDown: (event) => {
			const opened = keyboardMenuEvent(
				event,
				event.currentTarget.getBoundingClientRect(),
			);
			if (opened.isSome) open(opened.value, event.currentTarget, author);
		},
	});

	return { menu, targetFor };
};
