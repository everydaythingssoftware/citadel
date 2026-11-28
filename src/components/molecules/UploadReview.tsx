import clsx from "clsx";
import { useRef } from "react";
import { Reveal } from "@/components/atoms/Reveal";
import {
	ChevronLeftGlyph,
	ChevronRightGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, IconButton } from "@/components/ui";
import { useMediaQuery } from "@/lib/hooks/use-breakpoint";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import type { MatchChoice } from "@/lib/hooks/use-review-matches";
import { useScrolled } from "@/lib/hooks/use-scrolled";
import type { BookMatch } from "@/lib/services/library";
import { Destination } from "@/lib/uploads/matches";
import { type BookFile, UploadPhase } from "@/lib/uploads/queue";
import { CoverCarousel } from "./CoverCarousel";
import { CoverRow } from "./CoverRow";
import { UploadFiles } from "./UploadFiles";
import { MatchChooser, MatchDestination, MatchNote } from "./UploadMatches";
import styles from "./UploadReview.module.css";
import { UploadReviewCard } from "./UploadReviewCard";

/** Beyond this many books the dots would wrap; the position says it instead. */
const MAX_DOTS = 15;

export interface UploadReviewProps {
	deck: ReviewDeck;
	authorSuggestions?: string[];
	tagSuggestions?: string[];
	/** Back to the whole queue. */
	onBack: () => void;
	/** Closes the sheet; shown on phones, where this bar is the navigation bar. */
	onDone?: () => void;
	/** Books are read from this computer rather than uploaded. */
	local?: boolean;
	/** Books already in the library the current book may duplicate. */
	matches?: BookMatch[];
	/** Where the current book goes, when it may be a duplicate. */
	choice?: MatchChoice;
	/** The current book's formats ("EPUB"); more than one can be split. */
	formats?: readonly string[];
	/** The files the current book is made of. */
	files?: readonly BookFile[];
	/** Makes each of the current book's files a book of its own. */
	onSplit?: () => void;
}

/**
 * Reviews ready books: their covers in a row to swipe through, the current
 * book's details below, and Skip / Add to Library pinned at the bottom.
 */
export const UploadReview = ({
	deck,
	authorSuggestions,
	tagSuggestions,
	onBack,
	onDone,
	local = false,
	matches = [],
	choice,
	formats = [],
	files = [],
	onSplit,
}: UploadReviewProps) => {
	const toExisting =
		matches.length > 0 && choice?.destination === Destination.existing;
	// The last matches stay drawn while the note closes over them.
	const shownMatches = useRef(matches);
	if (matches.length > 0) shownMatches.current = matches;
	const { current } = deck;
	const scrollRef = useRef<HTMLDivElement>(null);
	const scrolled = useScrolled(scrollRef);
	const busy = current?.phase === UploadPhase.adding || deck.leaving;
	// With a mouse or trackpad, the row moves with Cover Flow's physics;
	// touch screens scroll natively.
	const physics = useMediaQuery("(pointer: fine)");
	const actions = (
		<>
			<Button disabled={!current || busy} onClick={() => void deck.skip()}>
				Skip
			</Button>
			<Button
				variant="primary"
				disabled={
					!current || busy || (!toExisting && deck.form.title.trim() === "")
				}
				onClick={() => void deck.add(choice?.addTo)}
			>
				{current?.phase === UploadPhase.adding
					? "Adding…"
					: (choice?.addLabel ?? "Add to Library")}
			</Button>
		</>
	);
	return (
		<section className={styles.review} aria-label="Review book">
			{/* Lifts off the form once the form scrolls under it. */}
			<header className={styles.header} data-scrolled={scrolled || undefined}>
				<button type="button" className={styles.back} onClick={onBack}>
					<ChevronLeftGlyph />
					<span className={styles.backWide}>
						{local ? "All books" : "All uploads"}
					</span>
					<span className={styles.backNarrow}>
						{local ? "Books" : "Uploads"}
					</span>
				</button>
				<nav className={styles.pager} aria-label="Ready books">
					<IconButton
						aria-label="Previous book"
						disabled={!deck.canPrevious}
						onClick={deck.previous}
					>
						<ChevronLeftGlyph />
					</IconButton>
					<span className={styles.position} aria-live="polite">
						{deck.count === 0
							? "None left"
							: `${deck.index + 1} of ${deck.count}`}
					</span>
					<IconButton
						aria-label="Next book"
						disabled={!deck.canNext}
						onClick={deck.next}
					>
						<ChevronRightGlyph />
					</IconButton>
				</nav>
				{onDone && (
					<button type="button" className={styles.done} onClick={onDone}>
						Done
					</button>
				)}
			</header>

			<div ref={scrollRef} className={styles.scroll}>
				{physics ? (
					<CoverRow
						items={deck.items}
						index={deck.index}
						departing={deck.departing}
						onSelect={deck.select}
					/>
				) : (
					<CoverCarousel
						items={deck.items}
						index={deck.index}
						departing={deck.departing}
						onSelect={deck.select}
					/>
				)}
				{/* Always there, so the card below doesn't move up as books go. */}
				<div className={styles.dots} aria-hidden="true">
					{deck.count > 1 &&
						deck.count <= MAX_DOTS &&
						deck.items.map((item, position) => (
							<span
								key={item.key}
								className={clsx(
									styles.dot,
									position === deck.index && styles.dotCurrent,
								)}
							/>
						))}
				</div>
				{current && files.length > 1 && (
					<UploadFiles files={files} onSplit={onSplit} />
				)}
				{current && choice && (
					<Reveal open={matches.length > 0} resetKey={current.key}>
						<MatchDestination
							destination={choice.destination}
							onChange={choice.setDestination}
						/>
						{/* Added as new, it still says which book it may duplicate. */}
						<Reveal open={!toExisting} resetKey={current.key}>
							<MatchNote matches={shownMatches.current} formats={formats} />
						</Reveal>
					</Reveal>
				)}
				{current && toExisting && choice && (
					<MatchChooser
						matches={matches}
						formats={formats}
						selectedId={choice.selected?.id}
						onSelect={choice.select}
					/>
				)}
				{current && !toExisting && (
					<UploadReviewCard
						bookKey={current.key}
						form={deck.form}
						errors={deck.errors}
						message={current.message}
						onChange={deck.updateForm}
						onLeaveField={deck.leaveField}
						detailsOpen={deck.detailsOpen}
						onToggleDetails={deck.toggleDetails}
						authorSuggestions={authorSuggestions}
						tagSuggestions={tagSuggestions}
					/>
				)}
				{/* Phones: the actions end the form, so nothing appears, goes or
				    resizes when a field brings up the keyboard. */}
				<div className={styles.formActions}>{actions}</div>
			</div>

			<footer className={styles.footer}>{actions}</footer>
		</section>
	);
};
