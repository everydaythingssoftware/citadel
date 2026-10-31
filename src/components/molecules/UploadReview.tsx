import clsx from "clsx";
import {
	ChevronLeftGlyph,
	ChevronRightGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, IconButton } from "@/components/ui";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import { UploadPhase } from "@/lib/uploads/queue";
import { canAddForm } from "@/lib/uploads/review";
import styles from "./UploadReview.module.css";
import { UploadReviewCard } from "./UploadReviewCard";

export const AddedMotion = {
	/** The card is dealt off to the left, onto an unseen pile. */
	deal: "deal",
	/** The card drops and shrinks into the footer, as if shelved. */
	shelve: "shelve",
	/** The card lifts up and away. */
	lift: "lift",
} as const;
export type TAddedMotion = (typeof AddedMotion)[keyof typeof AddedMotion];

export interface UploadReviewProps {
	deck: ReviewDeck;
	motion?: TAddedMotion;
	authorSuggestions?: string[];
	/** Back to the whole queue. */
	onBack: () => void;
	/** Closes the sheet; shown on phones, where this bar is the navigation bar. */
	onDone?: () => void;
}

/** Reviews ready books one card at a time: page between them, then add or skip. */
export const UploadReview = ({
	deck,
	motion = AddedMotion.deal,
	authorSuggestions,
	onBack,
	onDone,
}: UploadReviewProps) => {
	const { current, leaving, entered } = deck;
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

			<div className={styles.stage} data-motion={motion} {...deck.swipe}>
				{leaving && (
					<div
						key={`leaving-${leaving.item.key}`}
						className={clsx(styles.card, styles.leaving)}
						data-transition={leaving.transition}
						aria-hidden="true"
					>
						<UploadReviewCard item={leaving.item} form={leaving.form} inert />
					</div>
				)}
				{current && (
					<div
						key={current.key}
						className={clsx(styles.card, styles.entering)}
						data-transition={entered}
					>
						<UploadReviewCard
							item={current}
							form={deck.form}
							onChange={deck.updateForm}
							authorSuggestions={authorSuggestions}
						/>
					</div>
				)}
				{deck.canNext && <span className={styles.peek} aria-hidden="true" />}
			</div>

			{deck.count > 1 && (
				<div className={styles.dots} aria-hidden="true">
					{Array.from({ length: Math.min(deck.count, 9) }, (_, index) => (
						<span
							// Dots are positional.
							// biome-ignore lint/suspicious/noArrayIndexKey: one per position
							key={index}
							className={clsx(
								styles.dot,
								index === Math.min(deck.index, 8) && styles.dotCurrent,
							)}
						/>
					))}
				</div>
			)}

			<footer className={styles.footer}>
				<Button
					size="md"
					className={styles.skip}
					disabled={!current || adding}
					onClick={() => void deck.skip()}
				>
					Skip
				</Button>
				<Button
					size="md"
					variant="primary"
					className={styles.add}
					disabled={!current || adding || !canAddForm(deck.form)}
					onClick={() => void deck.add()}
				>
					{adding ? "Adding…" : "Add to Library"}
				</Button>
			</footer>
		</section>
	);
};
