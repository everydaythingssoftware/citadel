import clsx from "clsx";
import type { CSSProperties } from "react";
import { Hourglass, HourglassStyle } from "@/components/atoms/Hourglass";
import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
import {
	BooksGlyph,
	CalendarGlyph,
	DraftsGlyph,
	TrayGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, Tooltip } from "@/components/ui";
import type { Countdown } from "@/lib/uploads/countdown";
import type { QueueSummary } from "@/lib/uploads/queue";
import styles from "./UploadIndicator.module.css";

/** Ways the toolbar can show that books are waiting for review. */
export const ReviewIndicatorStyle = {
	/** Two pages: drafts waiting. */
	drafts: "drafts",
	/** An in-tray: things to deal with. */
	tray: "tray",
	/** A few book spines: books waiting to be shelved. */
	books: "books",
	/** A small dot, like an unread marker. */
	dot: "dot",
	/** A calendar page showing the day the drafts go. */
	calendar: "calendar",
	/** No icon: the button's bottom edge drains as time passes. */
	underline: "underline",
	/** No icon: the button's background empties as time passes. */
	fill: "fill",
	/** No icon: the time left, in words. */
	text: "text",
	/** A stopwatch dial winding down. */
	timer: "timer",
	/** An hourglass draining. */
	sand: "sand",
} as const;
export type TReviewIndicatorStyle =
	(typeof ReviewIndicatorStyle)[keyof typeof ReviewIndicatorStyle];

export interface UploadIndicatorProps {
	summary: QueueSummary;
	/** The soonest deadline among ready books. */
	countdown?: Countdown;
	variant?: TReviewIndicatorStyle;
	onOpen: () => void;
}

const ReviewMark = ({
	variant,
	deadline,
}: {
	variant: TReviewIndicatorStyle;
	deadline: Countdown;
}) => {
	switch (variant) {
		case ReviewIndicatorStyle.drafts:
			return <DraftsGlyph className={styles.glyph} />;
		case ReviewIndicatorStyle.tray:
			return <TrayGlyph className={styles.glyph} />;
		case ReviewIndicatorStyle.books:
			return <BooksGlyph className={styles.glyph} />;
		case ReviewIndicatorStyle.dot:
			return <span className={styles.dot} />;
		case ReviewIndicatorStyle.calendar:
			return (
				<CalendarGlyph
					className={styles.glyph}
					day={deadline.deadline.getDate()}
				/>
			);
		case ReviewIndicatorStyle.timer:
		case ReviewIndicatorStyle.sand:
			return (
				<Hourglass
					variant={
						variant === ReviewIndicatorStyle.timer
							? HourglassStyle.timer
							: HourglassStyle.sand
					}
					fraction={deadline.fraction}
					urgent={deadline.urgent}
					size={13}
					label={deadline.description}
				/>
			);
		default:
			return null;
	}
};

/**
 * Toolbar status for uploads carrying on while the sheet is closed: a
 * toolbar button like Add Book, showing upload progress or, once books wait
 * for review, that they're waiting and until when.
 */
export const UploadIndicator = ({
	summary,
	countdown,
	variant = ReviewIndicatorStyle.drafts,
	onOpen,
}: UploadIndicatorProps) => {
	if (summary.active === 0 && summary.ready === 0) return null;
	const uploading = summary.active > 0;
	const deadline = !uploading ? countdown : undefined;
	// These show time on the button itself and have no icon to stand in for
	// the label on phones.
	const iconless =
		deadline !== undefined &&
		(variant === ReviewIndicatorStyle.underline ||
			variant === ReviewIndicatorStyle.fill ||
			variant === ReviewIndicatorStyle.text);
	const label = uploading
		? `Uploading ${summary.active} ${summary.active === 1 ? "book" : "books"}`
		: deadline && variant === ReviewIndicatorStyle.text
			? `${summary.ready} to review · ${deadline.short}`
			: `${summary.ready} to review`;
	const button = (
		<Button
			size="sm"
			className={styles.indicator}
			onClick={onOpen}
			aria-label={deadline ? `${label}. ${deadline.description}` : label}
			data-variant={deadline ? variant : undefined}
			data-urgent={deadline?.urgent || undefined}
			style={
				deadline
					? ({ "--remaining": deadline.fraction } as CSSProperties)
					: undefined
			}
		>
			{uploading ? (
				<UploadProgressRing progress={summary.progress} size={13} />
			) : (
				deadline && <ReviewMark variant={variant} deadline={deadline} />
			)}
			<span className={clsx(styles.label, iconless && styles.labelAlways)}>
				{label}
			</span>
		</Button>
	);
	return deadline ? (
		<Tooltip label={deadline.description}>{button}</Tooltip>
	) : (
		button
	);
};
