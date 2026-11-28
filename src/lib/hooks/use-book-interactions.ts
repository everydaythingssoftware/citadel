import type { DragEvent, HTMLAttributes } from "react";
import { useMemo, useRef } from "react";
import type { LibraryBook } from "@/bindings";
import type { BookClickModifiers } from "@/lib/book-selection";
import { movedBeyondClickSlop } from "@/lib/book-selection";
import type { ContextMenuOpenEvent } from "./use-context-menu";

export interface BookActions {
	onPress: (
		index: number,
		book: LibraryBook,
		modifiers: BookClickModifiers,
	) => void;
	onContextMenu: (
		event: ContextMenuOpenEvent,
		index: number,
		book: LibraryBook,
	) => void;
	onDragStart: (event: DragEvent, index: number, book: LibraryBook) => void;
}

interface PressOrigin {
	bookId: string;
	x: number;
	y: number;
}
interface PressState {
	current: PressOrigin | null;
}

/** Bind selection, menus and dragging without owning the book's markup or layout. */
const bookInteractionBindings = (
	actions: BookActions,
	pressedAt: PressState,
) => {
	const cache = new WeakMap<
		LibraryBook,
		{ index: number; props: HTMLAttributes<HTMLDivElement> }
	>();
	return (book: LibraryBook, index: number): HTMLAttributes<HTMLDivElement> => {
		const cached = cache.get(book);
		if (cached?.index === index) return cached.props;
		const props: HTMLAttributes<HTMLDivElement> = {
			draggable: true,
			onPointerDown: (event) => {
				pressedAt.current = {
					bookId: book.id,
					x: event.clientX,
					y: event.clientY,
				};
			},
			onClick: (event) => {
				const from = pressedAt.current;
				pressedAt.current = null;
				if (
					from?.bookId === book.id &&
					movedBeyondClickSlop(from, { x: event.clientX, y: event.clientY })
				)
					return;
				actions.onPress(index, book, event);
			},
			onContextMenu: (event) => actions.onContextMenu(event, index, book),
			onDragStart: (event) => actions.onDragStart(event, index, book),
		};
		cache.set(book, { index, props });
		return props;
	};
};

export const useBookInteractions = (actions: BookActions) => {
	const pressedAt = useRef<PressOrigin | null>(null);
	return useMemo(() => bookInteractionBindings(actions, pressedAt), [actions]);
};
