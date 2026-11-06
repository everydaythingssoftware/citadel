import { useLibraryActions, useLibraryStore } from "@/stores/library/store";
import { Link as RouterLink } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import {
	type AnimationEvent,
	type FormEvent,
	type HTMLProps,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	BookUpdate,
	CustomColumnDef,
	LibraryAuthor,
	LibraryBook,
} from "@/bindings";
import {
	AlertDialog,
	Button,
	IconButton,
	Select,
	TagsInput,
	Textarea,
	TextInput,
	Tooltip,
} from "@/components/ui";
import { useDeleteBookConfirmation } from "@/lib/hooks/use-delete-book-confirmation";
import { deleteBookCopy, deleteBookDialogTitle } from "@/lib/delete-book-title";
import {
	type CustomFieldValue,
	buildCustomFieldValues,
	diffCustomValues,
	editableCustomColumns,
	emptyFieldValue,
} from "@/lib/custom-columns";
import { useMetadataBookActions } from "@/lib/hooks/use-metadata-book-actions";
import {
	KNOWN_LANGUAGE_NAMES,
	codeForLanguageName,
	languageNameForCode,
} from "@/lib/languages";
import { deepLinkForIdentifier } from "@/lib/metadata-providers/registry";
import { formatSeriesIndex } from "@/lib/series";
import { BookDeletion, type TBookDeletion } from "@/lib/services/library";
import { GlyphOpenExternal } from "../icons/RowGlyphs";
import { BookCover } from "../atoms/BookCover";
import { F7Trash } from "../icons/F7Trash";
import { BookActions } from "../molecules/BookActions";
import { MetadataSearchModal } from "../molecules/MetadataSearchModal";
import { RichTextEditor } from "../molecules/RichTextEditor";
import styles from "./EditBook.module.css";

/**
 * AppKit-style form row: right-aligned label in a fixed-width left gutter,
 * control filling the remaining width (Finder Get Info / Xcode inspectors).
 */
const FormRow = ({
	label,
	htmlFor,
	alignTop,
	children,
}: {
	label: string;
	htmlFor?: string;
	alignTop?: boolean;
	children: ReactNode;
}) => (
	<div
		className={
			alignTop ? `${styles.formRow} ${styles.formRowTop}` : styles.formRow
		}
	>
		<label className={styles.rowLabel} htmlFor={htmlFor}>
			{label}
		</label>
		<div className={styles.rowControl}>{children}</div>
	</div>
);

/**
 * A quiet strip of opt-in tag chips surfaced from a metadata lookup's subject
 * headings. The library vouches; the user decides — nothing is auto-applied.
 */
const SubjectSuggestions = ({
	subjects,
	source,
	fallbackLabel = "Suggested subjects:",
	onAdd,
	onAddAll,
}: {
	subjects: string[];
	source: string | null;
	fallbackLabel?: string;
	onAdd: (subject: string) => void;
	onAddAll: () => void;
}) => {
	if (subjects.length === 0) return null;
	return (
		<div className={styles.subjectStrip}>
			<span className={styles.subjectStripLabel}>
				{source ? `From ${source}:` : fallbackLabel}
			</span>
			{subjects.map((subject) => (
				<Button key={subject} variant="subtle" onClick={() => onAdd(subject)}>
					+ {subject}
				</Button>
			))}
			{subjects.length > 1 && (
				<Button variant="subtle" onClick={onAddAll}>
					Add all {subjects.length}
				</Button>
			)}
		</div>
	);
};

interface BookPageProps {
	allAuthorList: LibraryAuthor[];
	allTagList: string[];
	book: LibraryBook;
	/** Resolves with the new author, or nothing if it couldn't be added. */
	onCreateAuthor: (authorName: string) => Promise<LibraryAuthor | undefined>;
	onSave: (bookUpdate: BookUpdate) => Promise<void>;
	onDeleteIdentifier: (bookId: string, identifierId: number) => Promise<void>;
	onDelete?: () => Promise<void>;
	deletion?: TBookDeletion;
	onReloadBooks: () => Promise<void>;
	onUpsertIdentifier: (
		bookId: string,
		identifierId: number | null,
		label: string,
		value: string,
	) => Promise<void>;
}

export const BookPage = ({
	allAuthorList,
	allTagList,
	book,
	onCreateAuthor,
	onSave,
	onUpsertIdentifier,
	onDeleteIdentifier,
	onReloadBooks,
	onDelete,
	deletion = BookDeletion.trash,
}: BookPageProps) => {
	return (
		<>
			<EditBookForm
				allAuthorList={allAuthorList}
				allTagList={allTagList}
				onCreateAuthor={onCreateAuthor}
				book={book}
				onSave={onSave}
				onDeleteIdentifier={onDeleteIdentifier}
				onReloadBooks={onReloadBooks}
				onUpsertIdentifier={onUpsertIdentifier}
			/>
			{onDelete && (
				<DeleteBookSection
					title={book.title}
					deletion={deletion}
					onDelete={onDelete}
				/>
			)}
		</>
	);
};

const DeleteBookSection = ({
	title,
	deletion,
	onDelete,
}: {
	title: string;
	deletion: TBookDeletion;
	onDelete: () => Promise<void>;
}) => {
	const confirmation = useDeleteBookConfirmation(onDelete);
	const copy = deleteBookCopy(deletion);
	return (
		<section className={styles.deleteSection} aria-label="Delete book">
			{confirmation.error && (
				<p role="alert" className={styles.deleteError}>
					{confirmation.error}
				</p>
			)}
			<Button
				type="button"
				className={styles.deleteButton}
				disabled={confirmation.pending}
				onClick={() => confirmation.setOpen(true)}
			>
				{confirmation.pending ? "Deleting…" : "Delete Book…"}
			</Button>
			<AlertDialog
				open={confirmation.open}
				onOpenChange={confirmation.setOpen}
				title={deleteBookDialogTitle(title)}
				textAlign="left"
				description={copy.description}
				confirmLabel={copy.confirmLabel}
				destructive
				onConfirm={() => void confirmation.confirm()}
			/>
		</section>
	);
};

const BackChevron = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M15 18l-6-6 6-6" />
	</svg>
);

const Cover = ({ book }: { book: LibraryBook } & HTMLProps<HTMLDivElement>) => {
	return <BookCover book={book} disableFade fluid />;
};

interface EditBookFormValues {
	title: string;
	sortTitle: string;
	/** Series name; empty string means "not in a series". */
	series: string;
	/** Position within the series, kept as entered until save. */
	seriesIndex: string;
	authorList: string[];
	tagList: string[];
	/** Language display names (mapped to codes on save). */
	languageList: string[];
	identifierList: LibraryBook["identifier_list"];
	description: string;
	isRead: boolean;
}

/** Sentinel for "no value" in pop-up buttons; Radix items cannot be "". */
const UNSET_OPTION = "__unset__";

const CustomColumnInput = ({
	id,
	column,
	value,
	onChange,
}: {
	id: string;
	column: CustomColumnDef;
	value: CustomFieldValue;
	onChange: (value: CustomFieldValue) => void;
}) => {
	switch (column.datatype) {
		case "bool":
			return (
				<Select
					id={id}
					aria-label={column.name}
					options={[
						{ value: UNSET_OPTION, label: "Unset" },
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					]}
					value={value === "yes" || value === "no" ? value : UNSET_OPTION}
					onChange={(next) => onChange(next === UNSET_OPTION ? null : next)}
				/>
			);
		case "int":
		case "float":
			return (
				<TextInput
					id={id}
					inputMode={column.datatype === "int" ? "numeric" : "decimal"}
					value={
						typeof value === "number"
							? String(value)
							: typeof value === "string"
								? value
								: ""
					}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "text":
			if (column.is_multiple) {
				return (
					<TagsInput
						id={id}
						aria-label={column.name}
						placeholder="Search or add value"
						value={Array.isArray(value) ? value : []}
						onChange={onChange}
					/>
				);
			}
			return (
				<TextInput
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "comments":
			return (
				<Textarea
					id={id}
					rows={3}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "datetime":
			return (
				<TextInput
					id={id}
					placeholder="YYYY-MM-DD"
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "enumeration":
			return (
				<Select
					id={id}
					aria-label={column.name}
					options={[
						{ value: UNSET_OPTION, label: "Unset" },
						...column.enum_values.map((option) => ({
							value: option,
							label: option,
						})),
					]}
					value={
						typeof value === "string" && value !== "" ? value : UNSET_OPTION
					}
					onChange={(next) => onChange(next === UNSET_OPTION ? null : next)}
				/>
			);
		default:
			return null;
	}
};

const SAVED_NOTICE_MS = 3000;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const formValuesFromBook = (book: LibraryBook): EditBookFormValues => ({
	title: book.title,
	sortTitle: book.sortable_title ?? "",
	series: book.series ?? "",
	seriesIndex:
		book.series_index !== null ? formatSeriesIndex(book.series_index) : "",
	authorList: book.author_list.map((author) => author.name),
	tagList: book.tag_list,
	languageList: book.language_list.map(languageNameForCode),
	identifierList: book.identifier_list,
	description: book.description ?? "",
	isRead: book.is_read,
});

const EditBookForm = ({
	allAuthorList,
	allTagList,
	book,
	onCreateAuthor: createAuthor,
	onSave,
	onUpsertIdentifier,
	onDeleteIdentifier,
	onReloadBooks,
}: {
	allAuthorList: LibraryAuthor[];
	allTagList: string[];
	book: LibraryBook;
	onCreateAuthor: (name: string) => Promise<LibraryAuthor | undefined>;
	onSave: (update: BookUpdate) => Promise<void>;
	onDeleteIdentifier: (bookId: string, identifierId: number) => Promise<void>;
	onReloadBooks: () => Promise<void>;
	onUpsertIdentifier: (
		bookId: string,
		identifierId: number | null,
		label: string,
		value: string,
	) => Promise<void>;
}) => {
	const actions = useLibraryActions();
	// New authors are created as they're typed; saving waits for them so the
	// book is linked to their real IDs, however slow the library is to answer.
	const authorCreations = useRef(
		new Map<string, Promise<LibraryAuthor | undefined>>(),
	);
	const createAuthorOnce = useCallback(
		(name: string) => {
			const pending = authorCreations.current.get(name);
			if (pending) return pending;
			const creation = createAuthor(name);
			authorCreations.current.set(name, creation);
			creation.catch(() => authorCreations.current.delete(name));
			return creation;
		},
		[createAuthor],
	);
	const sourceLibrary = useLibraryStore((state) => state.library);
	const isCurrentLibrary = useCallback(
		() => useLibraryStore.getState().library === sourceLibrary,
		[sourceLibrary],
	);
	const [values, setValues] = useState<EditBookFormValues>(() =>
		formValuesFromBook(book),
	);
	// Dirty tracking: the last saved (or loaded) snapshot of the form.
	const [baseline, setBaseline] = useState<EditBookFormValues>(() =>
		formValuesFromBook(book),
	);
	const [isEditingDescription, setIsEditingDescription] = useState(false);
	const [newBookIdentifierLabel, setNewBookIdentifierLabel] = useState("");

	// Reset the form whenever the book reloads (e.g. after identifier upserts).
	useEffect(() => {
		const next = formValuesFromBook(book);
		setValues(next);
		setBaseline(next);
	}, [book]);

	const setFieldValue = useCallback((field: string, value: unknown) => {
		setValues((current) => ({ ...current, [field]: value }));
	}, []);

	// Minimal FormSetter facade for the metadata hook.
	const form = useMemo(() => ({ setFieldValue }), [setFieldValue]);

	const allAuthorNames = useMemo(
		() => allAuthorList.map((author) => author.name),
		[allAuthorList],
	);

	const [customColumns, setCustomColumns] = useState<CustomColumnDef[]>([]);
	const [customSnapshot, setCustomSnapshot] = useState<
		Record<string, CustomFieldValue>
	>({});
	const [customValues, setCustomValues] = useState<
		Record<string, CustomFieldValue>
	>({});
	const [customColumnError, setCustomColumnError] = useState<string | null>(
		null,
	);

	const loadCustomColumns = useCallback(
		async (isCancelled: () => boolean = () => false) => {
			const columns = await actions.listCustomColumns();
			if (isCancelled() || !isCurrentLibrary()) {
				return;
			}

			const editable = editableCustomColumns(columns);
			if (editable.length === 0) {
				setCustomColumns([]);
				setCustomSnapshot({});
				setCustomValues({});
				return;
			}

			if (!isCurrentLibrary()) return;
			const values = await actions.getCustomValuesForBook(book.id);
			if (isCancelled() || !isCurrentLibrary()) return;

			const fieldValues = buildCustomFieldValues(editable, values);
			setCustomColumns(editable);
			setCustomSnapshot(fieldValues);
			setCustomValues(fieldValues);
		},
		[book.id, actions, isCurrentLibrary],
	);

	useEffect(() => {
		let cancelled = false;
		loadCustomColumns(() => cancelled).catch((error: unknown) => {
			if (cancelled) {
				return;
			}
			console.error(error);
			setCustomColumnError(
				error instanceof Error ? error.message : String(error),
			);
			// Do not leave the previous book's inputs rendered under the error.
			setCustomColumns([]);
			setCustomSnapshot({});
			setCustomValues({});
		});
		return () => {
			cancelled = true;
		};
	}, [loadCustomColumns]);

	const customChanges = useMemo(
		() => diffCustomValues(customColumns, customSnapshot, customValues),
		[customColumns, customSnapshot, customValues],
	);

	const saveCustomChanges = useCallback(async () => {
		if (customChanges.length === 0) {
			return;
		}

		const attemptedValues = { ...customValues };
		const failures: { columnId: number; message: string }[] = [];
		for (const change of customChanges) {
			if (!isCurrentLibrary()) return;
			try {
				await actions.setCustomValue(book.id, change.columnId, change.value);
			} catch (error) {
				if (!isCurrentLibrary()) return;
				const columnName =
					customColumns.find((column) => column.column_id === change.columnId)
						?.name ?? `column ${change.columnId}`;
				failures.push({
					columnId: change.columnId,
					message: `${columnName}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}

		if (!isCurrentLibrary()) return;
		await loadCustomColumns();

		if (failures.length > 0) {
			// Keep the rejected inputs around so they can be fixed and re-saved.
			setCustomValues((refreshed) => {
				const next = { ...refreshed };
				for (const failure of failures) {
					const key = String(failure.columnId);
					next[key] = attemptedValues[key] ?? next[key] ?? null;
				}
				return next;
			});
			setCustomColumnError(
				failures.map((failure) => failure.message).join(" — "),
			);
		} else {
			setCustomColumnError(null);
		}
	}, [
		book.id,
		customChanges,
		customColumns,
		customValues,
		loadCustomColumns,
		actions,
		isCurrentLibrary,
	]);

	const meta = useMetadataBookActions({
		book,
		allAuthorNames,
		form,
		onUpsertIdentifier,
		onCreateAuthor: async (name) => {
			await createAuthorOnce(name);
		},
		onReloadBooks,
	});

	const hasChanges = useMemo(
		() =>
			JSON.stringify(values) !== JSON.stringify(baseline) ||
			customChanges.length > 0,
		[values, baseline, customChanges],
	);

	// Library subjects from the last lookup, offered as opt-in tag chips and
	// folded into the tag autocomplete. Only those not already applied show.
	const tagSuggestions = useMemo(
		() => [...new Set([...allTagList, ...meta.lastResolvedSubjects])],
		[allTagList, meta.lastResolvedSubjects],
	);
	const suggestableSubjects = useMemo(() => {
		const applied = new Set(values.tagList.map((tag) => tag.toLowerCase()));
		return meta.lastResolvedSubjects.filter(
			(subject) => !applied.has(subject.toLowerCase()),
		);
	}, [meta.lastResolvedSubjects, values.tagList]);
	const storedGenres = useMemo(() => {
		const column = customColumns.find(
			(customColumn) => customColumn.label === "citadel_genres",
		);
		if (!column) return [];
		const value = customValues[String(column.column_id)];
		return Array.isArray(value) ? value : [];
	}, [customColumns, customValues]);
	const suggestableGenres = useMemo(() => {
		const applied = new Set(storedGenres.map((genre) => genre.toLowerCase()));
		return meta.lastResolvedGenres.filter(
			(genre) => !applied.has(genre.toLowerCase()),
		);
	}, [meta.lastResolvedGenres, storedGenres]);
	const addGenres = useCallback(
		async (genres: string[]) => {
			if (!isCurrentLibrary()) return;
			try {
				await actions.addBookGenres(book.id, genres);
				if (!isCurrentLibrary()) return;
				await loadCustomColumns();
			} catch (error) {
				if (isCurrentLibrary())
					setCustomColumnError(
						error instanceof Error ? error.message : String(error),
					);
			}
		},
		[book.id, loadCustomColumns, actions, isCurrentLibrary],
	);

	const handleAuthorsChange = (next: string[]) => {
		// Authors typed in free-form that the library does not know yet get
		// created, mirroring the old MultiSelectCreatable behavior.
		for (const name of next) {
			if (!values.authorList.includes(name) && !allAuthorNames.includes(name)) {
				void createAuthorOnce(name);
			}
		}
		setFieldValue("authorList", next);
	};

	const revert = () => {
		setValues(baseline);
		setIsEditingDescription(false);
		setCustomValues(customSnapshot);
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void (async () => {
			// The outcome replaces whatever notice is showing (a lookup's, say)
			// in place, rather than clearing it first.
			try {
				await save();
				meta.setMessage({ type: "success", text: "Saved" });
			} catch (error) {
				meta.setMessage({
					type: "error",
					text: `Couldn't save: ${errorText(error)}`,
				});
			}
		})();
	};

	const save = async () => {
		const authorIdsFromName = await Promise.all(
			values.authorList.map(async (authorName) => {
				const known = allAuthorList.find(
					(author) => author.name === authorName,
				);
				if (known) return known.id;
				const created = await createAuthorOnce(authorName);
				if (!created) throw new Error(`Couldn't add the author ${authorName}`);
				return created.id;
			}),
		);

		const parsedSeriesIndex = Number.parseFloat(values.seriesIndex);
		const bookUpdate: BookUpdate = {
			title: values.title,
			author_id_list: authorIdsFromName,
			tag_list: values.tagList,
			timestamp: null,
			publication_date: null,
			is_read: values.isRead,
			description: values.description === "<p></p>" ? "" : values.description,
			// An empty name unlinks the book from its series.
			series: values.series.trim(),
			series_index: Number.isFinite(parsedSeriesIndex)
				? parsedSeriesIndex
				: null,
			language_list: values.languageList.map(codeForLanguageName),
		};

		// onSave reloads the book, which resets the form and its saved
		// snapshot to what the library now holds (a new title can change the
		// sort title, for one), so the pre-save values aren't the baseline.
		await onSave(bookUpdate);
		await saveCustomChanges();
	};

	// The notice keeps showing its last message while it animates out, so
	// clearing it (dismiss, a new lookup starting) never cuts it off.
	const { setMessage } = meta;
	const [shownMessage, setShownMessage] = useState(meta.message);
	if (meta.message && meta.message !== shownMessage) {
		setShownMessage(meta.message);
	}
	const noticeLeaving = !meta.message && shownMessage !== null;
	const finishLeaving = (event: AnimationEvent<HTMLDivElement>) => {
		if (event.target === event.currentTarget && noticeLeaving) {
			setShownMessage(null);
		}
	};
	const dismissNotice = () => setMessage(null);

	// "Saved" is a brief confirmation; errors stay until dismissed.
	const savedMessage =
		meta.message?.type === "success" && meta.message.text === "Saved"
			? meta.message
			: null;
	useEffect(() => {
		if (!savedMessage) return;
		const timer = setTimeout(
			() =>
				setMessage((current) => (current === savedMessage ? null : current)),
			SAVED_NOTICE_MS,
		);
		return () => clearTimeout(timer);
	}, [savedMessage, setMessage]);

	// An identifier error is about the identifier just tried, so it goes once
	// you type in the identifiers again or the next identifier change works.
	const identifierFailure = useRef<typeof meta.message>(null);
	// Arriving on a book puts focus on its title, so the next Tab goes into
	// this page rather than back through the sidebar.
	const titleRef = useRef<HTMLHeadingElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each book opened moves focus once
	useEffect(() => {
		titleRef.current?.focus({ preventScroll: true });
	}, [book.id]);
	const reportFailure = (what: string) => (error: unknown) => {
		const failure = {
			type: "error" as const,
			text: `${what}: ${errorText(error)}`,
		};
		identifierFailure.current = failure;
		setMessage(failure);
	};
	const clearIdentifierFailure = () => {
		const failure = identifierFailure.current;
		if (!failure) return;
		identifierFailure.current = null;
		setMessage((current) => (current === failure ? null : current));
	};

	return (
		<form className={styles.page} onSubmit={handleSubmit}>
			{/* The header and its notice stay pinned together, so a save's outcome
			    shows wherever the form is scrolled to. */}
			<div className={styles.pinnedTop}>
				<header className={styles.pageHeader}>
					<div className={styles.headerLead}>
						<Tooltip label="Back to library">
							<RouterLink
								to="/"
								aria-label="Back to library"
								className={styles.backLink}
							>
								<BackChevron />
							</RouterLink>
						</Tooltip>
						<h3 ref={titleRef} tabIndex={-1} className={styles.pageTitle}>
							{book.title}
						</h3>
					</div>
					<div className={styles.headerActions}>
						{hasChanges && (
							<Button variant="subtle" onClick={revert}>
								Revert
							</Button>
						)}
						<Button variant="primary" type="submit" disabled={!hasChanges}>
							Save
						</Button>
					</div>
				</header>
				{shownMessage && (
					<div
						className={`${styles.noticeSlot} ${
							noticeLeaving ? styles.noticeSlotLeaving : ""
						}`}
						onAnimationEnd={finishLeaving}
					>
						<div className={styles.noticeSlotInner}>
							<div
								key={`${shownMessage.type}:${shownMessage.text}`}
								role="alert"
								className={`${styles.notice} ${
									shownMessage.type === "success"
										? styles.noticeSuccess
										: styles.noticeError
								}`}
							>
								<span className={styles.noticeText}>{shownMessage.text}</span>
								<IconButton
									aria-label="Dismiss"
									className={styles.noticeClose}
									onClick={dismissNotice}
								>
									×
								</IconButton>
							</div>
						</div>
					</div>
				)}
			</div>
			<div className={styles.layout}>
				<div className={styles.sideColumn}>
					<Cover book={book} />
					<BookActions
						files={book.file_list}
						isRead={values.isRead}
						onReadChange={(isRead) => setFieldValue("isRead", isRead)}
					/>
				</div>
				<div className={styles.formColumn}>
					<section className={styles.section}>
						<FormRow label="Title" htmlFor="edit-book-title">
							<TextInput
								id="edit-book-title"
								value={values.title}
								onChange={(event) => setFieldValue("title", event.target.value)}
							/>
						</FormRow>
						<FormRow label="Sort title" htmlFor="edit-book-sort-title">
							<TextInput
								id="edit-book-sort-title"
								value={values.sortTitle}
								onChange={(event) =>
									setFieldValue("sortTitle", event.target.value)
								}
							/>
						</FormRow>
						<FormRow label="Series" htmlFor="edit-book-series">
							{/* The number belongs to the series, so it sits beside it. */}
							<div className={styles.inlineControls}>
								<TextInput
									id="edit-book-series"
									className={styles.flexGrow}
									placeholder="Not in a series"
									value={values.series}
									onChange={(event) =>
										setFieldValue("series", event.target.value)
									}
								/>
								<Tooltip label="Number in series">
									<span className={styles.seriesHash} aria-hidden="true">
										#
									</span>
								</Tooltip>
								<TextInput
									id="edit-book-series-index"
									className={styles.seriesIndex}
									aria-label="Number in series"
									type="number"
									step="any"
									min="0"
									placeholder="1"
									disabled={values.series.trim() === ""}
									value={values.seriesIndex}
									onChange={(event) =>
										setFieldValue("seriesIndex", event.target.value)
									}
								/>
							</div>
						</FormRow>
					</section>
					<section className={styles.section}>
						<FormRow label="Authors" alignTop htmlFor="edit-book-authors">
							<TagsInput
								id="edit-book-authors"
								aria-label="Authors"
								placeholder="Search or add author"
								suggestions={allAuthorNames}
								value={values.authorList}
								onChange={handleAuthorsChange}
							/>
						</FormRow>
						<FormRow label="Tags" alignTop htmlFor="edit-book-tags">
							<div className={styles.tagsField}>
								<TagsInput
									id="edit-book-tags"
									aria-label="Tags"
									placeholder="Search or add tag"
									suggestions={tagSuggestions}
									value={values.tagList}
									onChange={(next) => setFieldValue("tagList", next)}
								/>
								<SubjectSuggestions
									subjects={suggestableSubjects}
									source={meta.lastSubjectsSource}
									onAdd={(subject) =>
										setFieldValue("tagList", [...values.tagList, subject])
									}
									onAddAll={() =>
										setFieldValue("tagList", [
											...values.tagList,
											...suggestableSubjects,
										])
									}
								/>
							</div>
						</FormRow>
						{suggestableGenres.length > 0 && (
							<FormRow label="Genres" alignTop>
								<SubjectSuggestions
									subjects={suggestableGenres}
									source={null}
									fallbackLabel="Suggested genres:"
									onAdd={(genre) => void addGenres([genre])}
									onAddAll={() => void addGenres(suggestableGenres)}
								/>
							</FormRow>
						)}
						<FormRow label="Languages" alignTop htmlFor="edit-book-languages">
							<TagsInput
								id="edit-book-languages"
								aria-label="Languages"
								placeholder="Search or add language"
								suggestions={KNOWN_LANGUAGE_NAMES}
								value={values.languageList}
								onChange={(next) => setFieldValue("languageList", next)}
							/>
						</FormRow>
					</section>
					<section className={styles.section}>
						<div className={styles.sectionLabel}>Identifiers</div>
						<div className={styles.sectionBody}>
							{values.identifierList.map(({ label, id, value }, index) => (
								<FormRow
									key={id}
									label={label.toUpperCase()}
									htmlFor={`edit-book-identifier-${id}`}
								>
									<div className={styles.inlineControls}>
										<TextInput
											id={`edit-book-identifier-${id}`}
											className={styles.flexGrow}
											value={value}
											onChange={(event) => {
												const nextList = values.identifierList.map(
													(identifier, candidateIndex) =>
														candidateIndex === index
															? { ...identifier, value: event.target.value }
															: identifier,
												);
												setFieldValue("identifierList", nextList);
												clearIdentifierFailure();
											}}
											onBlur={(event) => {
												onUpsertIdentifier(
													book.id,
													id,
													label,
													event.target.value,
												)
													.then(clearIdentifierFailure)
													.catch(reportFailure("Couldn't save the identifier"));
											}}
										/>
										<div className={styles.identifierActions}>
											{deepLinkForIdentifier(label, value) && (
												<Tooltip label="Open record in browser">
													<IconButton
														aria-label="Open record in browser"
														onClick={() =>
															void meta.openIdentifierLink(label, value)
														}
													>
														<GlyphOpenExternal />
													</IconButton>
												</Tooltip>
											)}
											<Tooltip label="Remove identifier">
												<IconButton
													className={styles.removeIdentifier}
													aria-label="Remove identifier"
													onClick={() => {
														onDeleteIdentifier(book.id, id)
															.then(clearIdentifierFailure)
															.catch(
																reportFailure("Couldn't remove the identifier"),
															);
													}}
												>
													<F7Trash />
												</IconButton>
											</Tooltip>
										</div>
									</div>
								</FormRow>
							))}
							<FormRow
								label="Add identifier"
								htmlFor="edit-book-new-identifier"
							>
								<div className={styles.inlineControls}>
									<TextInput
										id="edit-book-new-identifier"
										placeholder="Type, e.g. ISBN or Goodreads"
										className={styles.flexGrow}
										value={newBookIdentifierLabel}
										onChange={(event) => {
											setNewBookIdentifierLabel(event.target.value);
											clearIdentifierFailure();
										}}
									/>
									<div className={styles.identifierActions}>
										<Button
											variant="default"
											disabled={newBookIdentifierLabel.trim() === ""}
											onClick={() => {
												onUpsertIdentifier(
													book.id,
													null,
													newBookIdentifierLabel,
													"",
												)
													.then(() => {
														setNewBookIdentifierLabel("");
														clearIdentifierFailure();
													})
													.catch(reportFailure("Couldn't add the identifier"));
											}}
										>
											Add
										</Button>
									</div>
								</div>
							</FormRow>
						</div>
					</section>
					{(customColumns.length > 0 || customColumnError) && (
						<section className={styles.section}>
							<div className={styles.sectionLabel}>Custom columns</div>
							<div className={styles.sectionBody}>
								{customColumnError && (
									<div
										role="alert"
										className={`${styles.notice} ${styles.noticeError}`}
									>
										<span className={styles.noticeText}>
											{customColumnError}
										</span>
										<IconButton
											aria-label="Dismiss"
											className={styles.noticeClose}
											onClick={() => setCustomColumnError(null)}
										>
											×
										</IconButton>
									</div>
								)}
								{customColumns.map((column) => {
									const key = String(column.column_id);
									const inputId = `edit-book-custom-${key}`;
									return (
										<FormRow
											key={key}
											label={column.name}
											htmlFor={inputId}
											alignTop={
												column.datatype === "comments" ||
												(column.datatype === "text" && column.is_multiple)
											}
										>
											<CustomColumnInput
												id={inputId}
												column={column}
												value={customValues[key] ?? emptyFieldValue(column)}
												onChange={(value) =>
													setCustomValues((previous) => ({
														...previous,
														[key]: value,
													}))
												}
											/>
										</FormRow>
									);
								})}
							</div>
						</section>
					)}
					{meta.anySourceEnabled && (
						<section className={styles.section}>
							<FormRow label="Metadata">
								<Button
									variant="default"
									onClick={() => meta.openSearch(values.title || "")}
								>
									Find Book Details…
								</Button>
							</FormRow>
						</section>
					)}
					<section className={styles.section}>
						<div className={styles.sectionHeader}>
							<div className={styles.sectionLabel}>Description</div>
							<Button
								variant="default"
								onClick={() => setIsEditingDescription(!isEditingDescription)}
							>
								{isEditingDescription ? "Preview" : "Edit"}
							</Button>
						</div>

						{isEditingDescription ? (
							<div className={styles.sectionBody}>
								<RichTextEditor
									aria-label="Description"
									autoFocus
									value={values.description}
									onChange={(html) => setFieldValue("description", html)}
								/>
							</div>
						) : (
							<div className={styles.sectionBody}>
								{values.description ? (
									<div
										className={styles.descriptionHtml}
										// biome-ignore lint/security/noDangerouslySetInnerHtml: We sanitize with DOMPurify
										dangerouslySetInnerHTML={{
											__html: DOMPurify.sanitize(values.description),
										}}
									/>
								) : (
									<p className={styles.emptyText}>
										No description. Choose Edit to add one.
									</p>
								)}
							</div>
						)}
					</section>
				</div>
			</div>

			{/* Unified metadata search sheet */}
			<MetadataSearchModal
				open={meta.isSearchModalOpen}
				onOpenChange={meta.setIsSearchModalOpen}
				query={meta.searchQuery}
				onQueryChange={meta.setSearchQuery}
				onSearch={meta.search}
				isSearching={meta.isSearching}
				results={meta.results}
				pendingProviderNames={meta.pendingProviderNames}
				onSelect={(result) => void meta.selectResult(result)}
				onStop={meta.stopSearch}
				onCoverError={meta.retryAfterCoverError}
				error={meta.message?.type === "error" ? meta.message.text : null}
			/>
		</form>
	);
};
