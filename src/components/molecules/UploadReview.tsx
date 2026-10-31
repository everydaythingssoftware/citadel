import clsx from "clsx";
import {
	ChevronLeftGlyph,
	ChevronRightGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, IconButton } from "@/components/ui";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import { UploadPhase } from "@/lib/uploads/queue";
import { AddedMotion, CoverCarousel, type TAddedMotion } from "./CoverCarousel";
import styles from "./UploadReview.module.css";
import { UploadReviewCard } from "./UploadReviewCard";

export { AddedMotion, type TAddedMotion };

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
	const adding = current?.phase === UploadPhase.adding;
	return (
		<section className={styles.review} aria-label="Review book">
			<header className={styles.header}>
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

			<div className={styles.scroll}>
				<CoverCarousel
					items={deck.items}
					index={deck.index}
					departing={deck.departing}
					motion={motion}
					onSelect={deck.select}
				/>
				{deck.count > 1 && (
					<div className={styles.dots} aria-hidden="true">
						{deck.items.map((item, position) => (
							<span
								key={item.key}
								className={clsx(
									styles.dot,
									position === deck.index && styles.dotCurrent,
								)}
							/>
						))}
					</div>
				)}
				{current && (
					<UploadReviewCard
						// One form per book, so focus and field state don't carry over.
						key={current.key}
						form={deck.form}
						errors={deck.errors}
						message={current.message}
						onChange={deck.updateForm}
						onLeaveField={deck.leaveField}
						authorSuggestions={authorSuggestions}
						tagSuggestions={tagSuggestions}
					/>
				)}
			</div>

			<footer className={styles.footer}>
				<Button
					size="md"
					disabled={!current || adding}
					onClick={() => void deck.skip()}
				>
					Skip
				</Button>
				<Button
					size="md"
					variant="primary"
					disabled={!current || adding || deck.form.title.trim() === ""}
					onClick={() => void deck.add()}
				>
					{adding ? "Adding…" : "Add to Library"}
				</Button>
			</footer>
		</section>
	);
};
