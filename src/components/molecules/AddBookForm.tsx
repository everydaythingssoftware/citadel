import { type ReactNode, useEffect, useState } from "react";
import { MetadataSearchModal } from "@/components/molecules/MetadataSearchModal";
import {
	Button,
	IconButton,
	TagsInput,
	TextInput,
	Tooltip,
} from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { useMetadataImportLookup } from "@/lib/hooks/use-metadata-import-lookup";
import { buildSearchQuery, type PendingMetadata } from "@/lib/metadata-import";
import styles from "./AddBookForm.module.css";

export interface AddBookForm {
	title: string;
	authorList: string[];
}

export interface AddBookFormProps {
	initial: AddBookForm;
	authorList: string[];
	fileName: string;
	onCreateAuthor: (newAuthorName: string) => Promise<void>;
	onSubmit?: (formData: AddBookForm) => Promise<void>;
	onCancel?: () => void;
	hideTitle?: boolean;
	/** The imported file's embedded identifier (e.g. an ISBN from an EPUB). */
	fileIdentifier?: string | null;
	onPendingMetadataChange?: (pending: PendingMetadata | null) => void;
}

export const title = "Add Book";

/**
 * AppKit-style form row (Finder Get Info / Xcode inspectors): right-aligned
 * label in a fixed-width left gutter, control filling the remaining width.
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

const DismissGlyph = () => (
	<svg
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M1.5 1.5l7 7M8.5 1.5l-7 7"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	</svg>
);

/**
 * One truncating line: dimmed directory that gives way first, emphasized
 * filename that stays readable. The full path is recoverable via `title`.
 */
const SelectedFile = ({ path }: { path: string }) => {
	const separatorIndex = Math.max(
		path.lastIndexOf("/"),
		path.lastIndexOf("\\"),
	);
	const directory = path.slice(0, separatorIndex + 1);
	const fileName = path.slice(separatorIndex + 1);
	return (
		<div className={styles.filePath} title={path}>
			{directory && <span className={styles.fileDir}>{directory}</span>}
			<span className={styles.fileName}>{fileName}</span>
		</div>
	);
};

export const AddBookForm = ({
	initial,
	authorList,
	onSubmit,
	onCancel,
	fileName,
	onCreateAuthor,
	hideTitle = false,
	fileIdentifier = null,
	onPendingMetadataChange,
}: AddBookFormProps) => {
	const [bookTitle, setBookTitle] = useState(initial.title);
	const [bookAuthors, setBookAuthors] = useState<string[]>(initial.authorList);
	// Track which fields the user has touched so the automatic on-mount
	// metadata lookup never clobbers their edits.
	const [titleEdited, setTitleEdited] = useState(false);
	const [authorsEdited, setAuthorsEdited] = useState(false);

	const meta = useMetadataImportLookup({ fileIdentifier });

	// biome-ignore lint/correctness/useExhaustiveDependencies: only react to pending changing; onPendingMetadataChange's identity is not stable.
	useEffect(() => {
		if (meta.pending) {
			// The automatic on-mount lookup must not clobber fields the user has
			// already edited; explicit lookups/selections always win.
			const isAuto = meta.pendingSource === "auto";
			if (meta.pending.title && !(isAuto && titleEdited)) {
				setBookTitle(meta.pending.title);
			}
			if (meta.pending.authors.length > 0 && !(isAuto && authorsEdited)) {
				setBookAuthors(meta.pending.authors);
			}
		}
		onPendingMetadataChange?.(meta.pending);
	}, [meta.pending, meta.pendingSource]);

	const handleAuthorsChange = (next: string[]) => {
		// Mirror the old creatable multiselect: committing a token that is not
		// an existing library author creates that author on the spot.
		for (const name of next) {
			if (
				!bookAuthors.includes(name) &&
				!authorList.some(
					(author) => author.toLowerCase() === name.toLowerCase(),
				)
			) {
				safeAsyncEventHandler(async () => onCreateAuthor(name))();
			}
		}
		setAuthorsEdited(true);
		setBookAuthors(next);
	};

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (onSubmit) {
					safeAsyncEventHandler(async () =>
						onSubmit({ title: bookTitle, authorList: bookAuthors }),
					)();
				}
			}}
		>
			{!hideTitle && <h4 className={styles.formTitle}>{title}</h4>}
			<div className={styles.rows}>
				<FormRow label="File">
					<SelectedFile path={fileName} />
				</FormRow>
				<FormRow label="Title" htmlFor="add-book-title">
					<TextInput
						id="add-book-title"
						value={bookTitle}
						onChange={(event) => {
							setTitleEdited(true);
							setBookTitle(event.currentTarget.value);
						}}
					/>
				</FormRow>
				<FormRow label="Authors" htmlFor="add-book-authors" alignTop>
					<TagsInput
						id="add-book-authors"
						placeholder="Search or add author"
						suggestions={authorList}
						value={bookAuthors}
						onChange={handleAuthorsChange}
					/>
				</FormRow>
				{meta.anySourceEnabled && (
					// No label: the button is self-describing, and a "Book details"
					// label clips in this modal's narrow gutter. It shares the control
					// column with the match note below it.
					<div className={styles.formRow}>
						<span aria-hidden="true" />
						<div className={styles.rowControl}>
							<Button
								variant="default"
								onClick={() =>
									meta.openSearch(buildSearchQuery(bookTitle, bookAuthors))
								}
							>
								Find book details…
							</Button>
						</div>
					</div>
				)}
				{meta.pending ? (
					<div className={styles.formRow}>
						<span aria-hidden="true" />
						<div
							className={`${styles.rowControl} ${styles.hardcoverNote}`}
							role="status"
						>
							<span className={styles.hardcoverNoteText}>
								Matched{" "}
								<span className={styles.hardcoverNoteTitle}>
									“{meta.pending.title}”
								</span>
								. Details will be added on import.
							</span>
							<Tooltip label="Remove match">
								<IconButton
									className={styles.hardcoverNoteDismiss}
									aria-label="Remove match"
									onClick={meta.clearPending}
								>
									<DismissGlyph />
								</IconButton>
							</Tooltip>
						</div>
					</div>
				) : (
					meta.message && (
						<div className={styles.formRow}>
							<span aria-hidden="true" />
							<div
								className={`${styles.rowControl} ${styles.hardcoverNote}`}
								data-tone="error"
								role="status"
							>
								<span className={styles.hardcoverNoteText}>
									{meta.message.text}
								</span>
								<Tooltip label="Dismiss">
									<IconButton
										className={styles.hardcoverNoteDismiss}
										aria-label="Dismiss message"
										onClick={meta.clearMessage}
									>
										<DismissGlyph />
									</IconButton>
								</Tooltip>
							</div>
						</div>
					)
				)}
			</div>
			<div className={styles.footer}>
				{onCancel && (
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button variant="primary" type="submit">
					Add Book
				</Button>
			</div>
			<MetadataSearchModal
				open={meta.isSearchModalOpen}
				onOpenChange={(open) => {
					if (!open) meta.closeSearchModal();
				}}
				query={meta.searchQuery}
				onQueryChange={meta.setSearchQuery}
				onSearch={meta.search}
				isSearching={meta.isSearching}
				results={meta.results}
				pendingProviderNames={meta.pendingProviderNames}
				onSelect={(result) => meta.selectSearchResult(result)}
				onStop={meta.stopSearch}
				onCoverError={meta.retryAfterCoverError}
				error={meta.message?.type === "error" ? meta.message.text : null}
				width={640}
			/>
		</form>
	);
};
