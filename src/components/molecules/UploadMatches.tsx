import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { useId } from "react";
import { BookCover } from "@/components/atoms/BookCover";
import { SegmentedControl } from "@/components/ui";
import { shortAuthorNames } from "@/lib/authors";
import type { BookMatch } from "@/lib/services/library";
import {
	Destination,
	shortTitle,
	type TDestination,
} from "@/lib/uploads/matches";
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

/** Why a book counts as a possible duplicate, in a few words. */
const REASONS: Record<BookMatch["reason"], string> = {
	isbn: "Same ISBN",
	titleAndAuthor: "Same title and author",
	title: "Same title",
};

/**
 * A book already in the library, enough to tell whether it's the same one:
 * what matched is emphasised, and so is a format the new file would replace.
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
	const byTitle = match.reason !== "isbn";
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
				<span className={clsx(styles.matchTitle, byTitle && styles.same)}>
					{match.title}
				</span>
				<span
					className={clsx(
						styles.soft,
						match.reason === "titleAndAuthor" && styles.same,
					)}
				>
					{match.authorNames.join(", ")}
				</span>
				<dl className={styles.facts}>
					{match.formats.length > 0 && (
						<>
							<dt>Formats</dt>
							<dd>
								{match.formats.map((format, index) => (
									<span
										key={format}
										className={clsx(formats.includes(format) && styles.same)}
									>
										{index > 0 && ", "}
										{format}
									</span>
								))}
							</dd>
						</>
					)}
					{match.isbn && (
						<>
							<dt>ISBN</dt>
							<dd className={clsx(match.reason === "isbn" && styles.same)}>
								{match.isbn}
							</dd>
						</>
					)}
					{added && (
						<>
							<dt>Added</dt>
							<dd>{added}</dd>
						</>
					)}
				</dl>
				<span className={styles.reason}>{REASONS[match.reason]}</span>
			</span>
		</>
	);
};

const matchSummary = (matches: BookMatch[]): string => {
	const [first] = matches;
	if (!first) return "";
	if (matches.length > 1) return `${matches.length} books in your library`;
	const by = shortAuthorNames(first.authorNames);
	return by ? `${shortTitle(first.title)} by ${by}` : shortTitle(first.title);
};

/**
 * Where the book goes: to the existing book, or as a new one. The label
 * reads "Add to" or "Add as" with the choice, crossfading between them.
 */
export const MatchDestination = ({
	destination,
	onChange,
}: {
	destination: TDestination;
	onChange: (destination: TDestination) => void;
}) => (
	<div className={styles.destination}>
		<span className={styles.destinationLabel} aria-hidden>
			<span data-shown={destination === Destination.existing || undefined}>
				Add to
			</span>
			<span data-shown={destination === Destination.new || undefined}>
				Add as
			</span>
		</span>
		<SegmentedControl
			aria-label="Add to"
			value={destination}
			onChange={(value) => onChange(value as TDestination)}
			items={[
				{ value: Destination.existing, label: "Existing Book" },
				{ value: Destination.new, label: "New Book" },
			]}
		/>
	</div>
);

/**
 * Adding to a book already there: the possible duplicate, or a choice of
 * them, under a label like any other field's.
 */
export const MatchChooser = ({
	matches,
	formats,
	selectedId,
	onSelect,
}: {
	matches: BookMatch[];
	/** The new book's formats, as "EPUB". */
	formats: readonly string[];
	selectedId: string | undefined;
	onSelect: (id: string) => void;
}) => {
	const name = useId();
	const [only] = matches;
	if (matches.length === 1 && only)
		return (
			<div className={styles.field}>
				<span className={styles.fieldLabel}>Possible duplicate</span>
				<div className={styles.choice}>
					<MatchedBook match={only} formats={formats} />
				</div>
			</div>
		);
	return (
		<fieldset className={clsx(styles.field, styles.chooser)}>
			<legend className={styles.fieldLabel}>Possible duplicates</legend>
			{matches.map((match) => (
				<label
					key={match.id}
					className={styles.choice}
					data-selected={match.id === selectedId || undefined}
				>
					<input
						type="radio"
						name={name}
						className={styles.radio}
						checked={match.id === selectedId}
						onChange={() => onSelect(match.id)}
					/>
					<MatchedBook match={match} formats={formats} />
				</label>
			))}
		</fieldset>
	);
};

/**
 * Part of the form while the book is added as a new one: which book it may
 * duplicate. The whole line opens that book in a popover.
 */
export const MatchNote = ({
	matches,
	formats,
}: {
	matches: BookMatch[];
	/** The new book's formats, as "EPUB". */
	formats: readonly string[];
}) => (
	<Popover.Root>
		<Popover.Trigger asChild>
			<button type="button" className={styles.note}>
				<span className={styles.noteLabel}>Possible duplicate</span> of{" "}
				<span className={styles.noteMatch}>{matchSummary(matches)}</span>
			</button>
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				className={styles.popover}
				side="bottom"
				align="start"
				sideOffset={6}
				collisionPadding={12}
			>
				{matches.map((match) => (
					<div key={match.id} className={styles.popoverBook}>
						<MatchedBook match={match} formats={formats} />
					</div>
				))}
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
);
