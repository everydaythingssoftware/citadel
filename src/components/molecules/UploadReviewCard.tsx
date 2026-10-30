import clsx from "clsx";
import { useId } from "react";
import { MotifCover } from "@/components/atoms/MotifCover";
import { TagsInput, TextInput } from "@/components/ui";
import type { QueueItem } from "@/lib/uploads/queue";
import { isValidDate, type ReviewForm } from "@/lib/uploads/review";
import styles from "./UploadReviewCard.module.css";

export interface UploadReviewCardProps {
	item: QueueItem;
	form: ReviewForm;
	onChange?: (patch: Partial<ReviewForm>) => void;
	authorSuggestions?: string[];
	/** A card on its way out: shown, not editable. */
	inert?: boolean;
	className?: string;
}

/** One uploaded book, prefilled from its file, ready to check and add. */
export const UploadReviewCard = ({
	item,
	form,
	onChange,
	authorSuggestions = [],
	inert = false,
	className,
}: UploadReviewCardProps) => {
	const id = useId();
	const change = (patch: Partial<ReviewForm>) => onChange?.(patch);
	return (
		<div className={clsx(styles.card, className)} inert={inert || undefined}>
			<div className={styles.cover}>
				{item.coverUrl ? (
					<img
						className={styles.coverImage}
						src={item.coverUrl}
						alt={`Cover of ${form.title || item.name}`}
					/>
				) : (
					<MotifCover
						className={styles.coverImage}
						seed={item.book?.title ?? item.name}
					/>
				)}
			</div>
			<div className={styles.fields}>
				<TextInput
					label="Title"
					value={form.title}
					onChange={(event) => change({ title: event.target.value })}
					error={form.title.trim() === "" ? "A book needs a title" : undefined}
				/>
				<TagsInput
					label="Authors"
					value={form.authors}
					onChange={(authors) => change({ authors })}
					suggestions={authorSuggestions}
					placeholder="Add author"
				/>
				<details className={styles.more}>
					<summary className={styles.summary}>More details</summary>
					<div className={styles.moreFields}>
						<TextInput
							label="Publisher"
							value={form.publisher}
							onChange={(event) => change({ publisher: event.target.value })}
						/>
						<div className={styles.pair}>
							<TextInput
								label="Language"
								value={form.language}
								placeholder="en"
								onChange={(event) => change({ language: event.target.value })}
							/>
							<TextInput
								id={`${id}-date`}
								label="Published"
								type="date"
								value={form.publicationDate}
								onChange={(event) =>
									change({ publicationDate: event.target.value })
								}
								error={
									isValidDate(form.publicationDate)
										? undefined
										: "Use a full date"
								}
							/>
						</div>
						<TagsInput
							label="Tags"
							value={form.tags}
							onChange={(tags) => change({ tags })}
							placeholder="Add tag"
						/>
						<TextInput
							label="ISBN"
							value={form.identifier}
							inputMode="numeric"
							onChange={(event) => change({ identifier: event.target.value })}
						/>
					</div>
				</details>
				{item.message && (
					<p className={styles.error} role="alert">
						{item.message}
					</p>
				)}
			</div>
		</div>
	);
};
