import * as Dialog from "@radix-ui/react-dialog";
import type { THourglassStyle } from "@/components/atoms/Hourglass";
import { PlusGlyph } from "@/components/icons/UploadGlyphs";
import { UploadQueueRow } from "@/components/molecules/UploadQueueRow";
import {
	type TAddedMotion,
	UploadReview,
} from "@/components/molecules/UploadReview";
import { Button, DialogCloseButton } from "@/components/ui";
import { ignorePopoverInteractOutside } from "@/components/ui/popover-interop";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import type { Countdown } from "@/lib/uploads/countdown";
import type { QueueItem, QueueSummary } from "@/lib/uploads/queue";
import styles from "./UploadSheet.module.css";

export interface UploadSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	items: QueueItem[];
	summary: QueueSummary;
	/** Why the queue is holding back, e.g. the server is full. */
	paused?: string;
	countdownFor: (item: QueueItem) => Countdown | undefined;
	hourglass?: THourglassStyle;
	/** Review one book at a time instead of showing the whole queue. */
	reviewing: boolean;
	deck: ReviewDeck;
	motion?: TAddedMotion;
	authorSuggestions?: string[];
	onChooseFiles: () => void;
	onReview: (key: string) => void;
	onBackToQueue: () => void;
	onRetry: (key: string) => void;
	onRemove: (key: string) => void;
	onAddAll: () => void;
	onCancelAll: () => void;
}

/**
 * The upload queue and review, as a sheet on wide screens and a full-screen
 * page on phones. Closing it leaves uploads running.
 */
export const UploadSheet = ({
	open,
	onOpenChange,
	items,
	summary,
	paused,
	countdownFor,
	hourglass,
	reviewing,
	deck,
	motion,
	authorSuggestions,
	onChooseFiles,
	onReview,
	onBackToQueue,
	onRetry,
	onRemove,
	onAddAll,
	onCancelAll,
}: UploadSheetProps) => (
	<Dialog.Root open={open} onOpenChange={onOpenChange}>
		<Dialog.Portal>
			<Dialog.Overlay className={styles.overlay} />
			<Dialog.Content
				className={styles.content}
				aria-describedby={undefined}
				onPointerDownOutside={ignorePopoverInteractOutside}
				onInteractOutside={ignorePopoverInteractOutside}
			>
				<div className={styles.header}>
					<Dialog.Title className={styles.title}>
						{reviewing ? "Review Book" : "Add Books"}
					</Dialog.Title>
					{!reviewing && summary.ready > 0 && (
						<span className={styles.status}>
							{summary.ready} of {items.length} ready
						</span>
					)}
					<Dialog.Close asChild>
						<DialogCloseButton className={styles.close} />
					</Dialog.Close>
				</div>
				<div className={styles.body}>
					{reviewing ? (
						<UploadReview
							deck={deck}
							motion={motion}
							authorSuggestions={authorSuggestions}
							onBack={onBackToQueue}
						/>
					) : (
						<>
							{items.length > 0 && (
								<ul className={styles.list} aria-label="Uploads">
									{items.map((item) => (
										<UploadQueueRow
											key={item.key}
											item={item}
											countdown={countdownFor(item)}
											hourglass={hourglass}
											onReview={() => onReview(item.key)}
											onRetry={() => onRetry(item.key)}
											onRemove={() => onRemove(item.key)}
										/>
									))}
								</ul>
							)}
							{paused && (
								<p className={styles.paused} role="status">
									{paused}
								</p>
							)}
							<button
								type="button"
								className={styles.dropzone}
								onClick={onChooseFiles}
							>
								<PlusGlyph className={styles.plus} />
								<span className={styles.dropzoneWide}>
									{items.length > 0
										? "Drop more books here or "
										: "Drop books here or "}
									<span className={styles.link}>choose files</span>
								</span>
								<span className={styles.dropzoneNarrow}>Choose Books</span>
							</button>
							{items.length > 0 && (
								<div className={styles.footer}>
									<Button onClick={onCancelAll}>Cancel All</Button>
									<Button
										variant="primary"
										disabled={summary.ready === 0}
										onClick={onAddAll}
									>
										{summary.ready === 0
											? "Add Ready Books"
											: summary.ready === 1
												? "Add 1 Ready Book"
												: `Add ${summary.ready} Ready Books`}
									</Button>
								</div>
							)}
						</>
					)}
				</div>
				<p className={styles.live} aria-live="polite">
					{summary.active > 0
						? `Uploading ${summary.active} ${summary.active === 1 ? "book" : "books"}`
						: summary.ready > 0
							? `${summary.ready} ready to add`
							: ""}
				</p>
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>
);
