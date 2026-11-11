import clsx from "clsx";
import React, { useCallback } from "react";
import type { LibraryBook } from "@/bindings";
import { useCoverThumb } from "@/stores/library/store";
import classes from "./BookCard.module.css";
import { BookCover } from "./BookCover";

type BookAction = (bookId: LibraryBook["id"]) => void;

interface BookActions {
	onViewBook: BookAction;
}

interface BookCardProps {
	book: LibraryBook;
	actions: BookActions;
	selected?: boolean;
}

export const BookCard = React.memo(function BookCard({
	book,
	actions: { onViewBook },
	selected,
}: BookCardProps) {
	// A click, not a press: touch browsers cancel the click when the finger
	// pans, so a scroll that starts on a cover doesn't open its drawer.
	const onCoverClick = useCallback(() => {
		onViewBook(book.id);
	}, [onViewBook, book]);
	// Grid cells render the 300px thumbnail instead of decoding the
	// full-resolution cover.
	const thumb = useCoverThumb(book.id);

	return (
		<div className={classes.cell} data-book-id={book.id}>
			<span
				className={clsx(
					classes.coverWrap,
					selected && classes.coverWrapSelected,
				)}
			>
				<BookCover book={book} fluid thumb={thumb} onClick={onCoverClick} />
			</span>
		</div>
	);
});
