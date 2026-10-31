import clsx from "clsx";
import { useRef } from "react";
import {
	ChevronLeftGlyph,
	ChevronRightGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, IconButton } from "@/components/ui";
import { devFlag } from "@/lib/dev-flags";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import { useScrolled } from "@/lib/hooks/use-scrolled";
import { UploadPhase } from "@/lib/uploads/queue";
import { AddedMotion, CoverCarousel, type TAddedMotion } from "./CoverCarousel";
import { CoverRow } from "./CoverRow";
import styles from "./UploadReview.module.css";
import { UploadReviewCard } from "./UploadReviewCard";

export { AddedMotion, type TAddedMotion };

/** Beyond this many books the dots would wrap; the position says it instead. */
const MAX_DOTS = 15;

export interface UploadReviewProps {
	deck: ReviewDeck;
	motion?: TAddedMotion;
	authorSuggestions?: string[];
	tagSuggestions?: string[];
	/** Back to the whole queue. */
	onBack: () => void;
	/** Closes the sheet; shown on phones, where this bar is the navigation bar. */
	onDone?: () => void;
}

/**
 * Reviews ready books: their covers in a row to swipe through, the current
 * book's details below, and Skip / Add to Library pinned at the bottom.
 */
export const UploadReview = ({
	deck,
	motion = AddedMotion.deal,
	authorSuggestions,
	tagSuggestions,
	onBack,
	onDone,
}: UploadReviewProps) => {
	const { current } = deck;
	const scrollRef = useRef<HTMLDivElement>(null);
	const scrolled = useScrolled(scrollRef);
	const busy = current?.phase === UploadPhase.adding || deck.leaving;
	// With a mouse or trackpad, the row moves with Cover Flow's physics;
	// touch screens scroll natively, unless the flag asks for the physics.
	const finePointer = useMediaQuery("(pointer: fine)");
	const physics = finePointer || devFlag("touchCovers") === "physics";
	const actions = (
		<>
			<Button
				size="md"
				disabled={!current || busy}
				onClick={() => void deck.skip()}
			>
				Skip
			</Button>
			<Button
				size="md"
				variant="primary"
				disabled={!current || busy || deck.form.title.trim() === ""}
				onClick={() => void deck.add()}
			>
				{current?.phase === UploadPhase.adding ? "Adding…" : "Add to Library"}
			</Button>
		</>
	);
	return (
		<section className={styles.review} aria-label="Review book">
			{/* Lifts off the form once the form scrolls under it. */}
			<header className={styles.header} data-scrolled={scrolled || undefined}>
				<button type="button" className={styles.back} onClick={onBack}>
					<ChevronLeftGlyph />
					<span className={styles.backWide}>All uploads</span>
					<span className={styles.backNarrow}>Uploads</span>
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
						motion={motion}
						onSelect={deck.select}
					/>
				) : (
					<CoverCarousel
						items={deck.items}
						index={deck.index}
						departing={deck.departing}
						motion={motion}
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
				{current && (
					<UploadReviewCard
						// One form per book, so focus and field state don't carry over.
						key={current.key}
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
