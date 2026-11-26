import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
	type CSSProperties,
	Fragment,
	type MouseEvent,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import { PlusGlyph, UploadGlyph } from "@/components/icons/UploadGlyphs";
import { UploadDuplicates } from "@/components/molecules/UploadDuplicates";
import { UploadQueueRow } from "@/components/molecules/UploadQueueRow";
import { UploadReview } from "@/components/molecules/UploadReview";
import {
	Button,
	DialogCloseButton,
	HoldButton,
	IconButton,
	Tooltip,
} from "@/components/ui";
import { pluralize } from "@/lib/book-count";
import { useFollowNewest } from "@/lib/hooks/use-follow-newest";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import {
	type DuplicateGroup,
	duplicateGroups,
	type QueueItem,
	type QueueSummary,
	UploadPhase,
} from "@/lib/uploads/queue";
import styles from "./UploadSheet.module.css";

/** Clicks this soon after a duplicate leaves were aimed at what it replaced. */
const CLICK_GUARD_MS = 400;

const duplicatesTitle = (
	duplicates: QueueItem[],
	groups: DuplicateGroup[],
): string =>
	`${pluralize(duplicates.length, "duplicate")} of ${pluralize(groups.length, "book")}`;

export interface UploadSheetProps {
	/** Books are read from this computer rather than uploaded. */
	local?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	items: QueueItem[];
	/** A batch being read here, whose books aren't in `items` yet. */
	reading?: { done: number; total: number; slow: boolean };
	/** Duplicates to decide on first, shown alone; empty for none. */
	duplicates?: QueueItem[];
	summary: QueueSummary;
	/** Why the queue is holding back, e.g. the server is full. */
	paused?: string;
	/** Review one book at a time instead of showing the whole queue. */
	reviewing: boolean;
	deck: ReviewDeck;
	authorSuggestions?: string[];
	tagSuggestions?: string[];
	onChooseFiles: () => void;
	onReview: (key: string) => void;
	onBackToQueue: () => void;
	onRetry: (key: string) => void;
	onRemove: (key: string) => void;
	onSkipDuplicates: (items: QueueItem[]) => void;
	onAddDuplicates: (items: QueueItem[]) => void;
	onAddAll: () => void;
	onCancelAll: () => void;
}

/**
 * The upload queue and review, as a sheet on wide screens and a full-screen
 * page on phones. Closing it leaves uploads running.
 */
export const UploadSheet = ({
	local = false,
	open,
	onOpenChange,
	items: currentItems,
	reading: currentReading,
	duplicates: currentDuplicates = [],
	summary,
	paused,
	reviewing,
	deck,
	authorSuggestions,
	tagSuggestions,
	onChooseFiles,
	onReview,
	onBackToQueue,
	onRetry,
	onRemove,
	onSkipDuplicates,
	onAddDuplicates,
	onAddAll,
	onCancelAll,
}: UploadSheetProps) => {
	const bodyRef = useRef<HTMLDivElement>(null);
	const current = {
		items: currentItems,
		reading: currentReading,
		undecided: currentDuplicates,
	};
	// What it lists stays put while the sheet closes over it.
	const last = useRef(current);
	if (open) last.current = current;
	const { items, reading, undecided } = last.current;
	const asking = undecided.length > 0;
	const groups = useMemo(() => duplicateGroups(undecided), [undecided]);
	// Nothing shows until a first batch is read, duplicates coming first.
	const pending = !asking && items.length === 0 ? reading : undefined;
	const rows = pending?.total ?? items.length;
	const status = reading?.slow
		? `Reading ${Math.min(reading.done + 1, reading.total)} of ${pluralize(reading.total, "book")}`
		: summary.ready > 0 && `${summary.ready} of ${items.length} ready`;
	const firstReady = items.find((item) => item.phase === UploadPhase.ready);
	const canAddAll = items.some(
		(item) => item.phase === UploadPhase.ready && !item.duplicate,
	);
	const cancelHint = local
		? "Hold to stop adding these books"
		: "Hold to cancel all uploads";
	useFollowNewest(bodyRef, reviewing ? 0 : rows);
	const primaryRef = useRef<HTMLButtonElement>(null);
	const shownCount = useRef(0);
	const changedAt = useRef(Number.NEGATIVE_INFINITY);
	useLayoutEffect(() => {
		if (undecided.length === shownCount.current) return;
		changedAt.current = performance.now();
		if (undecided.length === 0) primaryRef.current?.focus();
		shownCount.current = undecided.length;
	}, [undecided.length]);
	const guardClick = (event: MouseEvent) => {
		if (
			event.detail > 0 &&
			event.timeStamp - changedAt.current < CLICK_GUARD_MS
		)
			event.stopPropagation();
	};
	const cancelRow = (
		<HoldButton
			className={styles.cancelRow}
			label={local ? "Cancel Adding Books" : "Cancel All Uploads"}
			hint={cancelHint}
			onConfirm={onCancelAll}
		/>
	);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={styles.overlay} />
				<Dialog.Content
					className={clsx(
						styles.content,
						local && !reviewing && (pending || asking) && styles.sized,
					)}
					style={{ "--rows": rows } as CSSProperties}
					aria-describedby={undefined}
					onInteractOutside={(event) => event.preventDefault()}
				>
					{/* Phones get an iOS navigation bar: Done, the title, and +. */}
					<div
						className={styles.header}
						data-reviewing={reviewing || undefined}
					>
						<Dialog.Close asChild>
							<button type="button" className={styles.done}>
								Done
							</button>
						</Dialog.Close>
						<Dialog.Title className={styles.title}>
							{reviewing
								? "Review Book"
								: asking
									? duplicatesTitle(undecided, groups)
									: "Add Books"}
						</Dialog.Title>
						{!reviewing && !asking && status && (
							<span className={styles.status}>{status}</span>
						)}
						{!reviewing && !asking && items.length > 0 && (
							<Tooltip label="Choose more books…">
								<IconButton
									className={styles.addMore}
									aria-label="Choose more books"
									onClick={onChooseFiles}
								>
									<PlusGlyph />
								</IconButton>
							</Tooltip>
						)}
						<Dialog.Close asChild>
							<DialogCloseButton className={styles.close} />
						</Dialog.Close>
					</div>
					<div
						key={asking ? "duplicates" : "queue"}
						ref={asking ? undefined : bodyRef}
						className={clsx(styles.body, reviewing && styles.bodyReview)}
						onClickCapture={guardClick}
					>
						{reviewing ? (
							<UploadReview
								deck={deck}
								local={local}
								authorSuggestions={authorSuggestions}
								tagSuggestions={tagSuggestions}
								onBack={onBackToQueue}
								onDone={() => onOpenChange(false)}
							/>
						) : pending ? (
							cancelRow
						) : asking ? (
							<>
								<UploadDuplicates
									groups={groups}
									onSkip={onSkipDuplicates}
									onAddAnyway={onAddDuplicates}
								/>
								{cancelRow}
							</>
						) : (
							<>
								{items.length > 0 && (
									<ul
										className={styles.list}
										aria-label={local ? "Books to add" : "Uploads"}
									>
										{items.map((item) => (
											<UploadQueueRow
												key={item.key}
												item={item}
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
								{items.length > 0 ? (
									<>
										<button
											type="button"
											className={styles.dropzone}
											onClick={onChooseFiles}
										>
											<PlusGlyph className={styles.plus} />
											<span>
												Drop more books here or{" "}
												<span className={styles.link}>choose files</span>
											</span>
										</button>
										{cancelRow}
									</>
								) : (
									<div className={styles.empty}>
										<UploadGlyph className={styles.emptyGlyph} />
										<p className={styles.emptyTitle}>
											Add books to your library
										</p>
										<p className={styles.emptyHint}>
											<span className={styles.wideOnly}>
												Drop books anywhere on the window, or choose them from
												your files.
											</span>
											<span className={styles.narrowOnly}>
												Choose books from your files to{" "}
												{local ? "add them" : "upload them"}.
											</span>
										</p>
										<Button
											variant="primary"
											className={styles.choose}
											onClick={onChooseFiles}
										>
											Choose Books
										</Button>
									</div>
								)}
							</>
						)}
					</div>
					{/* Outside the scrolling list, so the list can bounce without it. */}
					{!reviewing && (pending || asking || items.length > 0) && (
						<div
							className={clsx(styles.footer, asking && styles.footerEven)}
							onClickCapture={guardClick}
						>
							{/* Held, not clicked: it throws away everything uploaded. */}
							<HoldButton
								className={styles.cancelAll}
								label="Cancel All"
								hint={cancelHint}
								onConfirm={onCancelAll}
							/>
							<span className={styles.spacer} />
							{pending ? null : asking ? (
								<Fragment key="duplicates">
									<Button onClick={() => onAddDuplicates(undecided)}>
										Add All Anyway
									</Button>
									<Button
										variant="primary"
										onClick={() => onSkipDuplicates(undecided)}
									>
										Skip All
									</Button>
								</Fragment>
							) : (
								<Fragment key="queue">
									{/* Reviewing first is the way in; adding everything as the
							    files describe it is the shortcut. */}
									<Button disabled={!canAddAll} onClick={onAddAll}>
										Add All
									</Button>
									<Button
										ref={primaryRef}
										variant="primary"
										disabled={firstReady === undefined}
										onClick={() => firstReady && onReview(firstReady.key)}
									>
										{summary.ready === 0
											? "Review Books"
											: summary.ready === 1
												? "Review 1 Book"
												: `Review ${summary.ready} Books`}
									</Button>
								</Fragment>
							)}
						</div>
					)}
					<p className={styles.live} aria-live="polite">
						{summary.active > 0
							? `${local ? "Reading" : "Uploading"} ${summary.active} ${summary.active === 1 ? "book" : "books"}`
							: asking
								? duplicatesTitle(undecided, groups)
								: summary.ready > 0
									? `${summary.ready} ready to review`
									: ""}
					</p>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
};
