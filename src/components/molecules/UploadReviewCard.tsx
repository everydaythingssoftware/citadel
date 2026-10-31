import clsx from "clsx";
import { useId } from "react";
import { ChevronDownGlyph } from "@/components/icons/UploadGlyphs";
import { TagsInput, TextInput } from "@/components/ui";
import { KNOWN_LANGUAGE_NAMES } from "@/lib/languages";
import type { ReviewField, ReviewForm } from "@/lib/uploads/review";
import styles from "./UploadReviewCard.module.css";

export interface UploadReviewCardProps {
	form: ReviewForm;
	/** Problems to show, for fields the person has left. */
	errors?: Partial<Record<ReviewField, string>>;
	/** Why the book couldn't be added, from the server. */
	message?: string;
	onChange?: (patch: Partial<ReviewForm>) => void;
	onLeaveField?: (field: ReviewField) => void;
	/** Publisher, language, date, tags and ISBN are showing. */
	detailsOpen?: boolean;
	onToggleDetails?: () => void;
	authorSuggestions?: string[];
	tagSuggestions?: string[];
	className?: string;
}

/** The editable metadata of one uploaded book, prefilled from its file. */
export const UploadReviewCard = ({
	form,
	errors = {},
	message,
	onChange,
	onLeaveField,
	detailsOpen = false,
	onToggleDetails,
	authorSuggestions = [],
	tagSuggestions = [],
	className,
}: UploadReviewCardProps) => {
	const change = (patch: Partial<ReviewForm>) => onChange?.(patch);
	const leave = (field: ReviewField) => () => onLeaveField?.(field);
	const detailsId = useId();
	return (
		<div className={clsx(styles.fields, className)}>
			<TextInput
				label="Title"
				value={form.title}
				enterKeyHint="next"
				autoComplete="off"
				onChange={(event) => change({ title: event.target.value })}
				onBlur={leave("title")}
				error={errors.title}
			/>
			<TagsInput
				label="Authors"
				value={form.authors}
				onChange={(authors) => change({ authors })}
				suggestions={authorSuggestions}
				placeholder="Add author"
			/>
			<div className={styles.more} data-open={detailsOpen || undefined}>
				{/* Closed, the whole row opens it and says what's inside; open,
				    only the label closes it, so clicking beside it does nothing. */}
				<button
					type="button"
					className={styles.disclosure}
					aria-expanded={detailsOpen}
					aria-controls={detailsId}
					onClick={onToggleDetails}
				>
					<span className={styles.disclosureLabel}>
						{detailsOpen ? "More Details" : "Add More Details"}
					</span>
					{!detailsOpen && (
						<span className={styles.disclosureHint}>
							Publisher, language, tags, ISBN
						</span>
					)}
					<ChevronDownGlyph className={styles.disclosureChevron} />
				</button>
				<div id={detailsId} className={styles.moreBody} inert={!detailsOpen}>
					<div className={styles.moreFields}>
						<TextInput
							label="Publisher"
							value={form.publisher}
							enterKeyHint="next"
							autoComplete="off"
							onChange={(event) => change({ publisher: event.target.value })}
						/>
						<TagsInput
							label="Language"
							value={form.language ? [form.language] : []}
							// One language: picking another replaces it.
							onChange={(languages) =>
								change({ language: languages.at(-1) ?? "" })
							}
							suggestions={KNOWN_LANGUAGE_NAMES}
							placeholder={form.language ? "" : "Search languages"}
						/>
						<TextInput
							className={styles.date}
							label="Published"
							type="date"
							value={form.publicationDate}
							onChange={(event) =>
								change({ publicationDate: event.target.value })
							}
							onBlur={leave("publicationDate")}
							error={errors.publicationDate}
						/>
						<TagsInput
							label="Tags"
							value={form.tags}
							onChange={(tags) => change({ tags })}
							suggestions={tagSuggestions}
							placeholder="Search or add tags"
						/>
						<TextInput
							label="ISBN"
							value={form.identifier}
							placeholder="ISBN-10 or ISBN-13"
							inputMode="text"
							autoCapitalize="characters"
							autoComplete="off"
							spellCheck={false}
							enterKeyHint="done"
							onChange={(event) => change({ identifier: event.target.value })}
							onBlur={leave("identifier")}
							error={errors.identifier}
						/>
					</div>
				</div>
			</div>
			{message && (
				<p className={styles.error} role="alert">
					{message}
				</p>
			)}
		</div>
	);
};
