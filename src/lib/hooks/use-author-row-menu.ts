import { useNavigate } from "@tanstack/react-router";
import type React from "react";
import { useRef } from "react";
import type { LibraryAuthor } from "@/bindings";
import type { ContextMenuEntry } from "@/lib/context-menu";
import { contextMenuPoint } from "@/lib/context-menu-point";
import {
	type ContextMenuController,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { useLibraryStore } from "@/stores/library/store";

export interface AuthorRowMenu {
	menu: ContextMenuController;
	/** The row's link, where focus goes back to when the menu closes. */
	returnFocusRef: React.RefObject<HTMLElement | null>;
	openFor: (
		event: React.MouseEvent<HTMLElement>,
		author: LibraryAuthor,
	) => void;
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
	const returnFocusRef = useRef<HTMLElement | null>(null);

	const openFor = (
		event: React.MouseEvent<HTMLElement>,
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
		const link = event.currentTarget.querySelector("a");
		returnFocusRef.current = link instanceof HTMLElement ? link : null;
		const rect = event.currentTarget.getBoundingClientRect();
		menu.openAt(contextMenuPoint(event, rect), items, author.name);
	};

	return { menu, returnFocusRef, openFor };
};
