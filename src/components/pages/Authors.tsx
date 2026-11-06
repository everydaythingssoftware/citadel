import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { AuthorUpdate, LibraryAuthor } from "@/bindings";
import { AuthorFilterControls } from "@/components/organisms/AuthorFilterControls";
import {
	AlertDialog,
	Button,
	FormField,
	IconButton,
	Sheet,
	TextInput,
} from "@/components/ui";
import { useAuthorFilters } from "@/lib/hooks/use-author-filters";
import { useVirtualListRows } from "@/lib/hooks/use-virtual-list-rows";
import {
	useAuthors,
	useAuthorsLoading,
	useLibraryActions,
	useLibraryStore,
} from "@/stores/library/store";
import { F7Pencil } from "../icons/F7Pencil";
import { F7Trash } from "../icons/F7Trash";
import { EmptyLibrary, EmptyState } from "../molecules/EmptyState";
import styles from "./Authors.module.css";

/**
 * Shared column template so the header row and every author row align:
 * name (flexible) | sort name (fixed, hidden narrow) | count | actions.
 */
const authorNoun = (count: number) => (count === 1 ? "author" : "authors");

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const Authors = () => {
	const authors = useAuthors();
	const loadingAuthors = useAuthorsLoading();
	const actions = useLibraryActions();

	const {
		filters,
		setSearchTerm,
		setSortOrder,
		setShowOnlyAuthorsWithoutBooks,
		filteredAuthors,
	} = useAuthorFilters(authors);

	const [editSheetOpened, setEditSheetOpened] = useState(false);
	const [deleteDialogOpened, setDeleteDialogOpened] = useState(false);

	const [authorToEdit, setAuthorToEdit] = useState<LibraryAuthor | null>(null);
	const [authorToDelete, setAuthorToDelete] = useState<LibraryAuthor | null>(
		null,
	);

	// The sheet opens from a per-row pencil button, not a Dialog.Trigger, so
	// Radix cannot restore focus on close; remember the opener ourselves.
	const editOpenerRef = useRef<HTMLElement | null>(null);

	const onSubmitEdit = useCallback(
		async (
			authorId: LibraryAuthor["id"],
			authorUpdate: AuthorUpdate,
		): Promise<void> => {
			if (actions) {
				await actions.updateAuthor(authorId, authorUpdate);
			}
		},
		[actions],
	);

	const onOpenEditAuthorSheet = useCallback(
		(authorId: string): void => {
			editOpenerRef.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
			setAuthorToEdit(
				filteredAuthors.find(({ id }) => id === authorId) ?? null,
			);
			setEditSheetOpened(true);
		},
		[filteredAuthors],
	);

	const onOpenDeleteAuthorDialog = useCallback(
		(authorId: string): void => {
			setAuthorToDelete(
				filteredAuthors.find(({ id }) => id === authorId) ?? null,
			);
			setDeleteDialogOpened(true);
		},
		[filteredAuthors],
	);

	// The confirmation closes as soon as it's confirmed, so a delete that
	// fails (the author still has books, say) is reported on the page.
	const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
	const onConfirmDeleteAuthor = useCallback(async (): Promise<void> => {
		if (!authorToDelete || !actions) return;
		setDeleteFailure(null);
		try {
			await actions.deleteAuthor(authorToDelete.id);
			setDeleteDialogOpened(false);
		} catch (error) {
			setDeleteFailure(
				`Couldn't delete ${authorToDelete.name}: ${errorText(error)}`,
			);
		}
	}, [actions, authorToDelete]);

	if (loadingAuthors) {
		return null;
	}

	// An empty library has no authors (they're created only when books are
	// imported), so teach the two ways to populate it instead of an empty list.
	if (authors.length === 0) {
		return (
			<div className={styles.page}>
				<EmptyLibrary />
			</div>
		);
	}

	const searchTerm = filters.searchTerm.trim();
	const noMatches = filteredAuthors.length === 0;

	return (
		<div className={styles.page}>
			{authorToEdit && (
				<EditAuthorSheet
					opened={editSheetOpened}
					onClose={() => setEditSheetOpened(false)}
					authorToEdit={authorToEdit}
					onSubmitEdit={onSubmitEdit}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						editOpenerRef.current?.focus();
					}}
				/>
			)}
			<AlertDialog
				open={deleteDialogOpened}
				onOpenChange={setDeleteDialogOpened}
				title="Delete author"
				description={
					authorToDelete
						? `Are you sure you want to delete "${authorToDelete.name}"? This cannot be undone.`
						: undefined
				}
				confirmLabel="Delete"
				destructive
				onConfirm={() => void onConfirmDeleteAuthor()}
			/>

			{deleteFailure && (
				<div role="alert" className={styles.failure}>
					<span>{deleteFailure}</span>
					<IconButton
						aria-label="Dismiss"
						onClick={() => setDeleteFailure(null)}
					>
						×
					</IconButton>
				</div>
			)}
			<div className={styles.filterBar}>
				<AuthorFilterControls
					filters={filters}
					onSearchChange={setSearchTerm}
					onSortOrderChange={setSortOrder}
					onShowOnlyAuthorsWithoutBooksChange={setShowOnlyAuthorsWithoutBooks}
				/>
			</div>

			{noMatches ? (
				searchTerm.length > 0 ? (
					<EmptyState
						title={`No authors match “${searchTerm}”`}
						description="Check the spelling, or search by surname."
					>
						<Button variant="default" onClick={() => setSearchTerm("")}>
							Clear Search
						</Button>
					</EmptyState>
				) : (
					<EmptyState
						title="Every author has books"
						description="No author is left without a book in this library."
					>
						<Button
							variant="default"
							onClick={() => setShowOnlyAuthorsWithoutBooks(false)}
						>
							Show all authors
						</Button>
					</EmptyState>
				)
			) : (
				<>
					<div
						data-authors-header=""
						className={clsx(styles.headerRow, styles.grid)}
					>
						<span className={styles.columnLabel}>Name</span>
						<span className={clsx(styles.columnLabel, styles.visibleFromMd)}>
							Sort name
						</span>
						<span className={clsx(styles.columnLabel, styles.columnLabelRight)}>
							Books
						</span>
						<span />
					</div>

					<AuthorRows
						authors={filteredAuthors}
						resetKey={JSON.stringify(filters)}
						onEditAuthor={onOpenEditAuthorSheet}
						onDeleteAuthor={onOpenDeleteAuthorDialog}
					/>

					<div data-authors-footer="" className={styles.footer}>
						<span className={styles.footerText}>
							{filteredAuthors.length === authors.length
								? `${authors.length} ${authorNoun(authors.length)}`
								: `${filteredAuthors.length} of ${authors.length} ${authorNoun(authors.length)}`}
						</span>
					</div>
				</>
			)}
		</div>
	);
};

const EditAuthorSheet = ({
	opened,
	onClose,
	authorToEdit,
	onSubmitEdit,
	onCloseAutoFocus,
}: {
	opened: boolean;
	onClose: () => void;
	authorToEdit: LibraryAuthor;
	onSubmitEdit: (
		authorId: LibraryAuthor["id"],
		authorUpdate: AuthorUpdate,
	) => Promise<void>;
	onCloseAutoFocus?: (event: Event) => void;
}) => {
	const [displayName, setDisplayName] = useState(authorToEdit.name ?? "");
	const [sortName, setSortName] = useState(authorToEdit.sortable_name ?? "");
	const [errors, setErrors] = useState<{
		displayName?: string;
		sortName?: string;
	}>({});
	const [saveFailure, setSaveFailure] = useState<string | null>(null);

	// Values reset whenever a different author is opened.
	useEffect(() => {
		setDisplayName(authorToEdit.name ?? "");
		setSortName(authorToEdit.sortable_name ?? "");
		setErrors({});
		setSaveFailure(null);
	}, [authorToEdit]);

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextErrors = {
			displayName: displayName.length > 0 ? undefined : "Name is required",
			sortName: sortName.length > 0 ? undefined : "Sort name is required",
		};
		if (nextErrors.displayName || nextErrors.sortName) {
			setErrors(nextErrors);
			return;
		}
		setSaveFailure(null);
		// Stays open on failure (a name another author has, say) so the
		// change isn't lost and the reason shows.
		onSubmitEdit(authorToEdit.id, {
			full_name: displayName,
			sortable_name: sortName,
			external_url: null,
		}).then(onClose, (error: unknown) => setSaveFailure(errorText(error)));
	};

	return (
		<Sheet
			open={opened}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title="Edit author"
			width={380}
			onCloseAutoFocus={onCloseAutoFocus}
		>
			<form onSubmit={onSubmit}>
				<div className={styles.sheetFields}>
					<FormField
						label="Full name"
						description="How the author's name is displayed"
						error={errors.displayName}
					>
						<TextInput
							value={displayName}
							onChange={(event) => {
								setDisplayName(event.currentTarget.value);
								setErrors((prev) => ({ ...prev, displayName: undefined }));
							}}
						/>
					</FormField>
					<FormField
						label="Sort name"
						description="Authors are sorted alphabetically by this name"
						error={errors.sortName}
					>
						<TextInput
							value={sortName}
							onChange={(event) => {
								setSortName(event.currentTarget.value);
								setErrors((prev) => ({ ...prev, sortName: undefined }));
							}}
						/>
					</FormField>
				</div>
				{saveFailure && (
					<p role="alert" className={styles.sheetFailure}>
						{saveFailure}
					</p>
				)}
				<div className={styles.sheetFooter}>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary">
						Save
					</Button>
				</div>
			</form>
		</Sheet>
	);
};

/**
 * The author list, windowed against the app's shared scroll region like the
 * Series/Tags/Publishers lists, so the sticky header and footer pin to it.
 * Editing an author keeps the reader's place; changing a filter returns to
 * the top.
 */
const AuthorRows = ({
	authors,
	resetKey,
	onEditAuthor,
	onDeleteAuthor,
}: {
	authors: LibraryAuthor[];
	resetKey: string;
	onEditAuthor: (authorId: string) => void;
	onDeleteAuthor: (authorId: string) => void;
}) => {
	const { rowsRef, virtualizer, scrollMargin } = useVirtualListRows(
		authors,
		resetKey,
	);

	return (
		<div
			ref={rowsRef}
			className={styles.rows}
			style={{ position: "relative", height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map((virtualRow) => {
				const author = authors[virtualRow.index];
				if (author === undefined) return null;
				return (
					<div
						key={virtualRow.key}
						ref={virtualizer.measureElement}
						data-index={virtualRow.index}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							transform: `translateY(${virtualRow.start - scrollMargin}px)`,
						}}
					>
						<AuthorRow
							author={author}
							onEditAuthor={onEditAuthor}
							onDeleteAuthor={onDeleteAuthor}
						/>
					</div>
				);
			})}
		</div>
	);
};

const AuthorRow = ({
	author,
	onEditAuthor,
	onDeleteAuthor,
}: {
	author: LibraryAuthor;
	onEditAuthor: (authorId: string) => void;
	onDeleteAuthor: (authorId: string) => void;
}) => {
	const canEdit = useLibraryStore((state) => state.library?.readOnly === false);
	return (
		// The whole row links to the library filtered by this author. The hover
		// background, 40px min-height, and the overlay-link positioning live in
		// styles.css (.ctd-author-row / .ctd-author-row-link).
		<div className={clsx("ctd-author-row", styles.row, styles.grid)}>
			{/* Real anchor overlaying the row so middle-click / cmd-click /
			    keyboard all work. The count link and the action icons sit above
			    it (position: relative + zIndex), so they keep working on their
			    own without stopPropagation. */}
			<Link
				to="/"
				search={{ author_id: author.id }}
				className="ctd-author-row-link"
				aria-label={`Show books by ${author.name}`}
			/>

			<span className={styles.cellText}>{author.name}</span>

			{author.sortable_name !== "" ? (
				<span
					className={clsx(styles.cellText, styles.dimmed, styles.visibleFromMd)}
				>
					{author.sortable_name}
				</span>
			) : (
				<div className={styles.visibleFromMd}>
					<span className={styles.badge}>No sort name</span>
				</div>
			)}

			<Link
				to="/"
				search={{ author_id: author.id }}
				className={styles.countLink}
			>
				{author.book_count}
			</Link>

			<div className={styles.actions}>
				{canEdit && (
					<>
						<IconButton
							className={styles.actionIcon}
							aria-label={`Edit ${author.name}`}
							onClick={() => onEditAuthor(author.id)}
						>
							<F7Pencil />
						</IconButton>
						{author.book_count === 0 ? (
							<IconButton
								className={clsx(styles.actionIcon, styles.dangerIcon)}
								aria-label={`Delete ${author.name}`}
								onClick={() => onDeleteAuthor(author.id)}
							>
								<F7Trash />
							</IconButton>
						) : (
							<span className={styles.actionSpacer} />
						)}
					</>
				)}
			</div>
		</div>
	);
};
