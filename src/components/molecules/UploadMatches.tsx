import clsx from "clsx";
import { Fragment, useId } from "react";
import { BookCover } from "@/components/atoms/BookCover";
import type { BookMatch } from "@/lib/services/library";
import styles from "./UploadMatches.module.css";

const addedDate = (added: string | null | undefined): string | undefined => {
	if (!added) return undefined;
	// A bare date is a calendar day, not midnight UTC.
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(added);
	const date = day
		? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
		: new Date(added);
	return Number.isNaN(date.getTime())
		? undefined
		: date.toLocaleDateString(undefined, {
				day: "numeric",
				month: "long",
				year: "numeric",
			});
};

/**
 * A book already here, enough to tell whether it's the same one. A format
 * the new file would replace is emphasised.
 */
export const MatchedBook = ({
	match,
	formats,
}: {
	match: BookMatch;
	/** The new book's formats, as "EPUB". */
	formats: readonly string[];
}) => {
	const added = addedDate(match.added);
	return (
		<>
			<span className={styles.matchCover}>
				<BookCover
					src={match.coverUrl ?? undefined}
					title={match.title}
					maxHeight={78}
				/>
			</span>
			<span className={styles.matchText}>
				<span className={styles.matchTitle}>{match.title}</span>
				<span className={styles.matchAuthors}>
					{match.authorNames.join(", ")}
				</span>
				<dl className={styles.facts}>
					{match.formats.length > 0 && (
						<>
							<dt>Formats</dt>
							<dd>
								{match.formats.map((format, index) => (
									<Fragment key={format}>
										{index > 0 && ", "}
										<span
											className={clsx(formats.includes(format) && styles.same)}
										>
											{format}
										</span>
									</Fragment>
								))}
							</dd>
						</>
					)}
					{match.isbn && (
						<>
							<dt>ISBN</dt>
							<dd>{match.isbn}</dd>
						</>
					)}
					{added && (
						<>
							<dt>Added</dt>
							<dd>{added}</dd>
						</>
					)}
				</dl>
			</span>
		</>
	);
};

/**
 * Asks the one thing a person can answer at a glance: is this a book
 * already here? Each possible duplicate is a "yes, this one"; the last
 * choice is "no, a different book". What adding does follows from it.
 */
export const MatchQuestion = ({
	matches,
	formats,
	sameId,
	onChoose,
}: {
	matches: BookMatch[];
	/** The new book's formats, as "EPUB". */
	formats: readonly string[];
	/** The match this book is the same as; undefined for a different book. */
	sameId: string | undefined;
	/** A match's id, or null for a different book. */
	onChoose: (id: string | null) => void;
}) => {
	const name = useId();
	return (
		<fieldset className={styles.question}>
			<legend className={styles.questionTitle}>
				{matches.length === 1
					? "Is this the same book?"
					: "Is this one of these books?"}
			</legend>
			{matches.map((match) => (
				<label
					key={match.id}
					className={styles.choice}
					data-selected={match.id === sameId || undefined}
				>
					<input
						type="radio"
						name={name}
						className={styles.radio}
						checked={match.id === sameId}
						onChange={() => onChoose(match.id)}
					/>
					<MatchedBook match={match} formats={formats} />
				</label>
			))}
			<label
				className={clsx(styles.choice, styles.different)}
				data-selected={sameId === undefined || undefined}
			>
				<input
					type="radio"
					name={name}
					className={styles.radio}
					checked={sameId === undefined}
					onChange={() => onChoose(null)}
				/>
				<span>No, it’s a different book</span>
			</label>
		</fieldset>
	);
};
