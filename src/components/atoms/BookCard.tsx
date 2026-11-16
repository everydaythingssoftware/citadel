import clsx from "clsx";
import React, { useRef } from "react";
import type { LibraryBook } from "@/bindings";
import { formatAuthorList } from "@/lib/authors";
import {
	type BookClickModifiers,
	movedBeyondClickSlop,
} from "@/lib/book-selection";
import type { ContextMenuTrigger } from "@/lib/context-menu-point";
import { useCoverThumb } from "@/stores/library/store";
import classes from "./BookCard.module.css";
import { BookCover } from "./BookCover";

export interface BookCardActions {
	onPress: (
		index: number,
		book: LibraryBook,
		modifiers: BookClickModifiers,
	) => void;
	onContextMenu: (
		event: ContextMenuTrigger,
		index: number,
		book: LibraryBook,
	) => void;
	onDragStart: (
		event: React.DragEvent,
		index: number,
		book: LibraryBook,
	) => void;
}

interface BookCardProps {
	book: LibraryBook;
	index: number;
	/** The whole result's length, for VoiceOver's "3 of 1,204". */
	setSize: number;
	actions: BookCardActions;
	selected?: boolean;
}

/** The DOM id `aria-activedescendant` points the grid at. */
export const bookCardDomId = (bookId: LibraryBook["id"]) => `book-${bookId}`;

export const BookCard = React.memo(function BookCard({
	book,
	index,
	setSize,
	actions,
	selected = false,
}: BookCardProps) {
	// Grid cells render the 300px thumbnail instead of decoding the
	// full-resolution cover.
	const thumb = useCoverThumb(book.id);
	// A press that wanders (a scroll on touch, a drag that never became one)
	// is not a click.
	const pressedAt = useRef<{ x: number; y: number } | null>(null);
	const authors = formatAuthorList(book.author_list);

	return (
		// biome-ignore lint/a11y/useFocusableInteractive: the listbox keeps focus and points at the cursor's option with aria-activedescendant; options are never focused themselves.
		<div
			className={classes.cell}
			data-book-id={book.id}
			id={bookCardDomId(book.id)}
			role="option"
			aria-selected={selected}
			aria-posinset={index + 1}
			aria-setsize={setSize}
			aria-label={authors ? `${book.title}, ${authors}` : book.title}
		>
			<span
				className={clsx(
					classes.coverWrap,
					selected && classes.coverWrapSelected,
				)}
			>
				<BookCover
					book={book}
					fluid
					thumb={thumb}
					draggable
					onPointerDown={(event) => {
						pressedAt.current = { x: event.clientX, y: event.clientY };
					}}
					onClick={(event) => {
						const from = pressedAt.current;
						pressedAt.current = null;
						if (
							from !== null &&
							movedBeyondClickSlop(from, { x: event.clientX, y: event.clientY })
						)
							return;
						actions.onPress(index, book, event);
					}}
					onContextMenu={(event) => actions.onContextMenu(event, index, book)}
					onDragStart={(event) => actions.onDragStart(event, index, book)}
				/>
			</span>
		</div>
	);
});
