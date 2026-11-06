import clsx from "clsx";
import { StagedCover } from "@/components/atoms/StagedCover";
import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
import {
	AlertGlyph,
	ChevronRightGlyph,
	XmarkGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, IconButton } from "@/components/ui";
import { type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import styles from "./UploadQueueRow.module.css";

export interface UploadQueueRowProps {
	item: QueueItem;
	onReview?: () => void;
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
			return item.message ?? "Couldn't upload this file";
	}
};

const Thumbnail = ({ item }: { item: QueueItem }) => {
	if (item.phase === UploadPhase.failed || item.phase === UploadPhase.rejected)
		return (
			<span className={clsx(styles.thumb, styles.problem)}>
				<AlertGlyph />
			</span>
		);
	if (item.book)
		return (
			<StagedCover
				className={styles.thumb}
				coverUrl={item.coverUrl}
				seed={item.book.title}
			/>
		);
	return <span className={clsx(styles.thumb, styles.pending)} />;
};

/** One file in the upload queue, with what's happening to it and what you can do. */
export const UploadQueueRow = ({
	item,
	onReview,
	onRetry,
	onRemove,
}: UploadQueueRowProps) => {
	const problem =
		item.phase === UploadPhase.failed ||
		item.phase === UploadPhase.rejected ||
		(item.phase === UploadPhase.ready && item.message !== undefined);
	return (
		<li className={styles.row} data-phase={item.phase}>
			<Thumbnail item={item} />
			<div className={styles.text}>
				<span className={styles.name}>{item.name}</span>
				<span className={clsx(styles.subtitle, problem && styles.danger)}>
					{subtitle(item)}
				</span>
			</div>
			<div className={styles.trailing}>
				{/* Waiting and uploading share one ring with a stop button, so
				    every file that can still be stopped is stopped the same way. */}
				{(item.phase === UploadPhase.uploading ||
					item.phase === UploadPhase.waiting) && (
					<UploadProgressRing
						progress={
							item.phase === UploadPhase.uploading && item.size
								? item.sentBytes / item.size
								: 0
						}
						onStop={onRemove}
						stopLabel={
							item.phase === UploadPhase.uploading
								? `Stop uploading ${item.name}`
								: `Remove ${item.name}`
						}
					/>
				)}
				{(item.phase === UploadPhase.reading ||
					item.phase === UploadPhase.adding) && (
					<span className={styles.ringSlot}>
						<UploadProgressRing
							progress={0}
							indeterminate
							label={subtitle(item)}
						/>
					</span>
				)}
				{item.phase === UploadPhase.ready && (
					// On phones the whole row taps through to review (the button
					// stretches over it) and shows a chevron instead.
					<Button
						size="sm"
						className={styles.review}
						onClick={onReview}
						aria-label={`Review ${item.name}`}
					>
						<span className={styles.reviewLabel}>Review</span>
						<ChevronRightGlyph className={styles.chevron} />
					</Button>
				)}
				{item.phase === UploadPhase.failed && item.file && (
					<Button size="sm" onClick={onRetry}>
						Try Again
					</Button>
				)}
				{item.phase === UploadPhase.rejected ? (
					<Button size="sm" variant="subtle" onClick={onRemove}>
						Dismiss
					</Button>
				) : (
					item.phase === UploadPhase.failed && (
						<IconButton aria-label={`Remove ${item.name}`} onClick={onRemove}>
							<XmarkGlyph />
						</IconButton>
					)
				)}
			</div>
		</li>
	);
};
