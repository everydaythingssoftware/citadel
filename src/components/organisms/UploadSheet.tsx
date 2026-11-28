import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { PlusGlyph, UploadGlyph } from "@/components/icons/UploadGlyphs";
import { UploadQueueRow } from "@/components/molecules/UploadQueueRow";
import { UploadReview } from "@/components/molecules/UploadReview";
import {
	AlertDialog,
	Button,
	DialogCloseButton,
	HoldButton,
	IconButton,
	Tooltip,
} from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/use-breakpoint";
import { useFollowNewest } from "@/lib/hooks/use-follow-newest";
import { usePageSheet } from "@/lib/hooks/use-page-sheet";
import { usePendingGrace } from "@/lib/hooks/use-pending-grace";
import type { ReviewDeck } from "@/lib/hooks/use-review-deck";
import type { MatchChoice } from "@/lib/hooks/use-review-matches";
import { useScrollEdges } from "@/lib/hooks/use-scroll-edges";
import { useSheetHeight } from "@/lib/hooks/use-sheet-height";
import type { BookMatch } from "@/lib/services/library";
import {
	type BookFile,
	type BookRow,
	isActive,
	type QueueSections,
	type QueueSummary,
} from "@/lib/uploads/queue";
import styles from "./UploadSheet.module.css";

/** The review's height on wide screens: room for the covers and the form. */
const REVIEW_HEIGHT = 680;
/** Space the sheet leaves below the toolbar and above the window's bottom. */
const SHEET_MARGIN = 112;

export interface UploadSheetProps {
	/** Books are read from this computer rather than uploaded. */
	local?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** New books (and files on their way), then possible duplicates. */
	sections: QueueSections;
	summary: QueueSummary;
	/** Why the queue is holding back, e.g. the server is full. */
	paused?: string;
	/** Books chosen again while already waiting, to point out. */
	noticed?: { keys: string[]; id: number };
	/** Review one book at a time instead of showing the whole queue. */
	reviewing: boolean;
	deck: ReviewDeck;
	/** The book under review's possible duplicates, formats and destination. */
	matches?: BookMatch[];
	choice?: MatchChoice;
	formats?: readonly string[];
	/** The files the book under review is made of. */
	files?: readonly BookFile[];
	onSplit?: () => void;
	authorSuggestions?: string[];
	tagSuggestions?: string[];
	onChooseFiles: () => void;
	/** Opens the review at a book. */
	onReview: (key: string) => void;
	/** Opens the review at the first book. */
	onReviewBooks: () => void;
	onBackToQueue: () => void;
	onRetry: (key: string) => void;
	onRemove: (key: string) => void;
	/** Adds every new book as its file describes it; possible duplicates stay. */
	onAddNewBooks: () => void;
	/** Throws away every book not yet added, and closes. */
	onDiscardAll: () => void;
}

const Rows = ({
	rows,
	noticed,
	onReview,
	onRetry,
	onRemove,
}: {
	rows: BookRow[];
	noticed?: { keys: string[]; id: number };
	onReview: (key: string) => void;
	onRetry: (key: string) => void;
	onRemove: (key: string) => void;
}) =>
	rows.map((row) => (
		<UploadQueueRow
			key={row.key}
			item={row.lead}
			files={row.items.length}
			noticed={
				row.items.some((item) => noticed?.keys.includes(item.key))
					? noticed?.id
					: undefined
			}
			onReview={() => onReview(row.key)}
			onRetry={() => onRetry(row.key)}
			onRemove={() => onRemove(row.key)}
		/>
	));

/**
 * The books being added, and their review, as a sheet on wide screens and a
 * full-screen page on phones. A ready book is one target that opens its
 * review; possible duplicates wait in their own section, after the rest, for
 * Review Books, while Add New Books adds the others as their files describe
 * them. Closing leaves the books waiting (uploads carry on); Cancel All, or
 * Discard Books on a phone, throws them away.
 */
export const UploadSheet = ({
	local = false,
	open,
	onOpenChange,
	sections,
	summary,
	paused,
	noticed,
	reviewing,
	deck,
	matches,
	choice,
	formats,
	files,
	onSplit,
	authorSuggestions,
	tagSuggestions,
	onChooseFiles,
	onReview,
	onReviewBooks,
	onBackToQueue,
	onRetry,
	onRemove,
	onAddNewBooks,
	onDiscardAll,
}: UploadSheetProps) => {
	const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const reviewBooksRef = useRef<HTMLButtonElement>(null);
	const [confirming, setConfirming] = useState(false);
	// The list slides back in when it returns from a review.
	const wasReviewing = useRef(reviewing);
	const returned = useRef(false);
	if (wasReviewing.current && !reviewing) returned.current = true;
	if (reviewing || !open) returned.current = false;
	wasReviewing.current = reviewing;
	const returning = returned.current;
	const discarding = useRef(false);
	const { possibleDuplicates } = sections;
	// Files read in a blink go straight to their book; slower ones show it.
	const books = usePendingGrace(sections.books, (row) => isActive(row.lead));
	const count = sections.books.length + possibleDuplicates.length;
	const ready = summary.ready > 0;
	const canAddNew = books.some((row) => row.lead.phase === "ready");
	const cancelHint = local
		? "Hold to stop adding these books"
		: "Hold to cancel all uploads";
	const edges = useScrollEdges(bodyRef);
	useFollowNewest(bodyRef, reviewing ? 0 : count);
	useSheetHeight({
		sheet,
		scroller: bodyRef,
		content: listRef,
		fixed: reviewing
			? Math.min(REVIEW_HEIGHT, window.innerHeight - SHEET_MARGIN)
			: undefined,
	});
	// A phone shows the sheet as the page, so the document scrolls it.
	const page = useMediaQuery(PHONE_QUERY);
	usePageSheet(open, page);
	// Each view starts at its top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on switching view
	useEffect(() => {
		if (page) window.scrollTo(0, 0);
	}, [page, reviewing]);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} modal={!page}>
			<Dialog.Portal>
				<Dialog.Overlay className={styles.overlay} />
				<Dialog.Content
					ref={setSheet}
					className={styles.content}
					data-reviewing={reviewing || undefined}
					aria-describedby={undefined}
					onInteractOutside={(event) => event.preventDefault()}
					// Return reviews the books, rather than the first control in the
					// header taking focus (and showing its tooltip).
					onOpenAutoFocus={(event) => {
						const target = reviewBooksRef.current;
						event.preventDefault();
						if (target && !target.disabled) target.focus();
					}}
				>
					{/* Phones get an iOS navigation bar: Cancel, the title, and +. */}
					<div
						className={clsx(styles.header, edges.above && styles.lifted)}
						data-reviewing={reviewing || undefined}
					>
						{count > 0 ? (
							<button
								type="button"
								className={styles.done}
								onClick={() => setConfirming(true)}
							>
								Cancel
							</button>
						) : (
							<Dialog.Close asChild>
								<button type="button" className={styles.done}>
									Done
								</button>
							</Dialog.Close>
						)}
						<Dialog.Title className={styles.title}>
							{reviewing ? "Review Book" : "Add Books"}
						</Dialog.Title>
						{!reviewing && count > 0 && (
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
						ref={bodyRef}
						className={clsx(
							styles.body,
							"ctd-scroller",
							reviewing && styles.bodyReview,
						)}
					>
						{reviewing ? (
							<UploadReview
								deck={deck}
								local={local}
								matches={matches}
								choice={choice}
								formats={formats}
								files={files}
								onSplit={onSplit}
								authorSuggestions={authorSuggestions}
								tagSuggestions={tagSuggestions}
								onBack={onBackToQueue}
								onDone={() => onOpenChange(false)}
							/>
						) : (
							<div
								ref={listRef}
								className={styles.stage}
								data-returning={returning || undefined}
							>
								{count > 0 ? (
									<>
										<ul
											className={styles.list}
											aria-label={local ? "Books to add" : "Uploads"}
										>
											<Rows
												rows={books}
												noticed={noticed}
												onReview={onReview}
												onRetry={onRetry}
												onRemove={onRemove}
											/>
										</ul>
										{possibleDuplicates.length > 0 && (
											<section aria-labelledby="possible-duplicates">
												<h3
													id="possible-duplicates"
													className={styles.sectionLabel}
												>
													Possible duplicates
												</h3>
												<ul className={styles.list}>
													<Rows
														rows={possibleDuplicates}
														noticed={noticed}
														onReview={onReview}
														onRetry={onRetry}
														onRemove={onRemove}
													/>
												</ul>
											</section>
										)}
										{paused && (
											<p className={styles.paused} role="status">
												{paused}
											</p>
										)}
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
							</div>
						)}
					</div>
					{/* Outside the scrolling list, so the list can bounce without it. */}
					{!reviewing && count > 0 && (
						<div className={clsx(styles.footer, edges.below && styles.lifted)}>
							{/* Held, not clicked: it throws away everything uploaded. */}
							<HoldButton
								className={styles.cancelAll}
								label="Cancel All"
								hint={cancelHint}
								onConfirm={onDiscardAll}
							/>
							<span className={styles.spacer} />
							{canAddNew && (
								<Button onClick={onAddNewBooks}>Add New Books</Button>
							)}
							<Button
								ref={reviewBooksRef}
								className={styles.primary}
								variant="primary"
								disabled={!ready}
								onClick={onReviewBooks}
							>
								Review Books
							</Button>
						</div>
					)}
					<p className={styles.live} aria-live="polite">
						{summary.active > 0
							? `${local ? "Reading" : "Uploading"} ${summary.active} ${summary.active === 1 ? "book" : "books"}`
							: summary.ready > 0
								? `${summary.ready} ready to review`
								: ""}
					</p>
				</Dialog.Content>
			</Dialog.Portal>
			<AlertDialog
				open={confirming}
				onOpenChange={(next) => {
					setConfirming(next);
					if (next) return;
					// Review Later: the books wait, the sheet goes.
					if (!discarding.current) onOpenChange(false);
					discarding.current = false;
				}}
				title="Discard the books you haven't added?"
				description="Review Later keeps them here until you come back."
				confirmLabel="Discard Books"
				cancelLabel="Review Later"
				destructive
				onConfirm={() => {
					discarding.current = true;
					onDiscardAll();
				}}
			/>
		</Dialog.Root>
	);
};
