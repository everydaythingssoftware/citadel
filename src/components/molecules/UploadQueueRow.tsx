import clsx from "clsx";
import { useEffect, useRef } from "react";
import { BookCover } from "@/components/atoms/BookCover";
import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
import {
	AlertGlyph,
	ChevronRightGlyph,
	XmarkGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, IconButton, Spinner } from "@/components/ui";
import { hasSource, type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import styles from "./UploadQueueRow.module.css";

export interface UploadQueueRowProps {
	/** The book's file, or the first of its files. */
	item: QueueItem;
	/** How many files make up the book; more than one stacks the cover. */
	files?: number;
	/** Opens the review at this book; the whole row is its target. */
	onReview?: () => void;
	/**
	 * Set when the book was just chosen again while already waiting: the row
	 * scrolls into view and glows once. A new value glows again.
	 */
	noticed?: number;
	onRetry?: () => void;
	onRemove?: () => void;
}

const subtitle = (item: QueueItem): string => {
	switch (item.phase) {
		case UploadPhase.waiting:
			return "Waiting";
		case UploadPhase.uploading:
			return "Uploading…";
		case UploadPhase.reading:
			return "Reading book…";
		case UploadPhase.adding:
			return "Adding…";
		case UploadPhase.added:
			return "Added";
		case UploadPhase.ready:
			return (
				item.message ?? (item.book?.authorNames.join(", ") || "Ready to add")
			);
		case UploadPhase.failed:
		case UploadPhase.rejected:
			return item.message ?? "Couldn't add this file";
	}
};

const Thumbnail = ({
	item,
	stacked = false,
}: {
	item: QueueItem;
	stacked?: boolean;
}) => {
	if (item.phase === UploadPhase.failed || item.phase === UploadPhase.rejected)
		return (
			<span className={clsx(styles.thumb, styles.problem)}>
				<AlertGlyph />
			</span>
		);
	if (item.book)
		return (
			<span
				className={clsx(
					styles.thumb,
					styles.coverSlot,
					stacked && styles.stacked,
				)}
			>
				<BookCover
					alt=""
					provisional
					src={item.coverUrl}
					title={item.book.title}
					maxHeight="100cqh"
				/>
			</span>
		);
	return <span className={clsx(styles.thumb, styles.pending)} />;
};

/**
 * One book in the upload queue: its cover, title and author. A ready book is
 * one big target that opens its review; a file still on its way shows its
 * progress, and a problem what you can do about it.
 */
export const UploadQueueRow = ({
	item,
	files = 1,
	noticed,
	onReview,
	onRetry,
	onRemove,
}: UploadQueueRowProps) => {
	const rowRef = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (noticed !== undefined)
			rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [noticed]);
	const problem =
		item.phase === UploadPhase.failed ||
		item.phase === UploadPhase.rejected ||
		(item.phase === UploadPhase.ready && item.message !== undefined);
	return (
		<li className={styles.row} data-phase={item.phase} ref={rowRef}>
			{noticed !== undefined && (
				<span key={noticed} className={styles.notice} aria-hidden />
			)}
			{item.phase === UploadPhase.ready && onReview && (
				<button
					type="button"
					className={styles.target}
					aria-label={`Review ${item.name}`}
					onClick={onReview}
				/>
			)}
			<Thumbnail item={item} stacked={files > 1} />
			<div className={styles.text}>
				<span className={styles.name}>{item.name}</span>
				<span className={clsx(styles.subtitle, problem && styles.danger)}>
					{subtitle(item)}
				</span>
			</div>
			<div className={styles.trailing}>
				{item.phase === UploadPhase.uploading && (
					<UploadProgressRing
						progress={item.size ? item.sentBytes / item.size : 0}
						onStop={onRemove}
						stopLabel={`Stop uploading ${item.name}`}
					/>
				)}
				{item.phase === UploadPhase.reading && (
					// Busy, but still yours to drop: the spinner turns into an ×
					// under the pointer, like the upload ring.
					<button
						type="button"
						className={styles.busyCancel}
						aria-label={`Stop reading ${item.name}`}
						onClick={onRemove}
					>
						<Spinner size={18} className={styles.busySpinner} />
						<XmarkGlyph className={styles.busyX} />
					</button>
				)}
				{item.phase === UploadPhase.adding && (
					<Spinner size={18} aria-label={subtitle(item)} />
				)}
				{item.phase === UploadPhase.ready && onReview && (
					// Phones end a row that opens something in a disclosure chevron.
					<ChevronRightGlyph className={styles.chevron} aria-hidden />
				)}
				{item.phase === UploadPhase.failed && hasSource(item) && (
					<Button onClick={onRetry}>Try Again</Button>
				)}
				{item.phase === UploadPhase.rejected ? (
					<Button variant="subtle" onClick={onRemove}>
						Dismiss
					</Button>
				) : (
					// Waiting and failed files show their ×; reading and uploading
					// ones show it on hover; adding (the final write to the
					// library) runs to the end.
					(item.phase === UploadPhase.waiting ||
						item.phase === UploadPhase.failed) && (
						<IconButton aria-label={`Remove ${item.name}`} onClick={onRemove}>
							<XmarkGlyph />
						</IconButton>
					)
				)}
			</div>
		</li>
	);
};
