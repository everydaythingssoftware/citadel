import {
	createFileRoute,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { type CSSProperties, useCallback } from "react";
import type { BookUpdate, NewAuthor } from "@/bindings";
import { BookPage } from "@/components/pages/EditBook";
import { Spinner } from "@/components/ui";
import { tagListChanged } from "@/lib/domain/tag";
import { useEditBookData } from "@/lib/hooks/use-edit-book-data";
import { useOnLibraryFlip } from "@/lib/hooks/use-on-library-flip";
import {
	LibraryState,
	useAuthors,
	useLibraryActions,
	useLibraryState,
} from "@/stores/library/store";

const centeredFill: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	height: "100%",
};

const EditBookRoute = () => {
	const { bookId } = useParams({ from: "/books/$bookId" });
	const state = useLibraryState();
	const actions = useLibraryActions();
	const navigate = useNavigate();

	// A library flip invalidates the bookId this route was opened with: the
	// id belongs to the outgoing library, so the incoming fetch lands null
	// and the page would sit on "Book not found." forever. Photos-style,
	// switching libraries closes the item being viewed — go home, replacing
	// history so Back cannot return to a dead id, before the flip's first
	// paint of this route. List routes (/authors, /series) are
	// library-agnostic and self-heal on a flip, so they need no treatment.
	useOnLibraryFlip(
		useCallback(() => {
			void navigate({ to: "/", replace: true });
		}, [navigate]),
	);

	// Scoped fetches: this route loads exactly its own book and the tag
	// vocabulary (for the tag autocomplete) — never the whole library.
	const { book, allTagList, loading, error, refreshBook, refreshTags } =
		useEditBookData(bookId);
	const allAuthorList = useAuthors();

	const onSave = useCallback(
		async (bookUpdate: BookUpdate) => {
			if (!actions) return;
			const tagsChanged = tagListChanged(
				book?.tag_list ?? [],
				bookUpdate.tag_list,
			);
			// updateBook drops the paged grid cache (visible pages refetch
			// lazily); this route then re-fetches only its own data.
			await actions.updateBook(bookId, bookUpdate);
			await refreshBook();
			if (tagsChanged) {
				await refreshTags();
			}
		},
		[actions, bookId, book, refreshBook, refreshTags],
	);

	const onCreateAuthor = useCallback(
		async (authorName: string) => {
			const newAuthor: NewAuthor = {
				name: authorName,
				sortable_name: authorName,
			};

			if (actions) {
				await actions.createAuthors([newAuthor]);
			}
		},
		[actions],
	);

	const onUpsertIdentifier = useCallback(
		async (
			bookId: string,
			identifierId: number | null,
			label: string,
			value: string,
		) => {
			if (!actions) return;
			await actions.upsertBookIdentifier(bookId, identifierId, label, value);
			// The form resets from the book prop; re-fetch so the new
			// identifier row appears.
			await refreshBook();
		},
		[actions, refreshBook],
	);

	const onDeleteIdentifier = useCallback(
		async (bookId: string, identifierId: number) => {
			if (!actions) return;
			await actions.deleteBookIdentifier(bookId, identifierId);
			await refreshBook();
		},
		[actions, refreshBook],
	);

	const onReloadBooks = useCallback(async () => {
		if (!actions) return;
		// Hardcover imports change many fields at once: drop stale grid
		// pages, then refresh this route's book and tag vocabulary.
		actions.invalidateBooks();
		await Promise.all([refreshBook(), refreshTags()]);
	}, [actions, refreshBook, refreshTags]);

	// Spinner only for the initial fetch; refreshes after edits keep the
	// (stale-for-a-moment) form on screen instead of flashing.
	if (state !== LibraryState.ready || loading) {
		return (
			<div style={centeredFill}>
				<Spinner size={18} />
			</div>
		);
	}
	if (!book) {
		return (
			<div style={centeredFill}>
				<span style={{ fontSize: 13, color: "var(--ctd-ink-soft)" }}>
					{error ?? "Book not found."}
				</span>
			</div>
		);
	}

	return (
		<BookPage
			allAuthorList={allAuthorList}
			allTagList={allTagList}
			book={book}
			onCreateAuthor={onCreateAuthor}
			onSave={onSave}
			onUpsertIdentifier={onUpsertIdentifier}
			onDeleteIdentifier={onDeleteIdentifier}
			onReloadBooks={onReloadBooks}
		/>
	);
};

export const Route = createFileRoute("/books/$bookId")({
	component: EditBookRoute,
});
