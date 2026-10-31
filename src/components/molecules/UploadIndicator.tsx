import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
import {
	BookDownloadGlyph,
	BookSparkleGlyph,
} from "@/components/icons/UploadGlyphs";
import { Button, Tooltip } from "@/components/ui";
import type { Countdown } from "@/lib/uploads/countdown";
import type { QueueSummary } from "@/lib/uploads/queue";
import styles from "./UploadIndicator.module.css";

/** Icons for new books waiting to join the library. */
export const ReviewIndicatorStyle = {
	/** A book with a sparkle: a new arrival. */
	arrival: "arrival",
	/** A book with an arrow down into it: downloaded. */
	download: "download",
} as const;
export type TReviewIndicatorStyle =
	(typeof ReviewIndicatorStyle)[keyof typeof ReviewIndicatorStyle];

const GLYPHS = {
	arrival: BookSparkleGlyph,
	download: BookDownloadGlyph,
} satisfies Record<TReviewIndicatorStyle, unknown>;

export interface UploadIndicatorProps {
	summary: QueueSummary;
	/** The soonest deadline among ready books. */
	countdown?: Countdown;
	variant?: TReviewIndicatorStyle;
	onOpen: () => void;
}

/**
 * Toolbar status for uploads carrying on while the sheet is closed: a
 * toolbar button like Add Book, showing upload progress or, once new books
 * wait for review, how many. Near the deadline it turns brass and calls
 * gently for attention; the tooltip says when the drafts go.
 */
export const UploadIndicator = ({
	summary,
	countdown,
	variant = ReviewIndicatorStyle.arrival,
	onOpen,
}: UploadIndicatorProps) => {
	if (summary.active === 0 && summary.ready === 0) return null;
	const uploading = summary.active > 0;
	const deadline = !uploading ? countdown : undefined;
	const urgent = deadline?.urgent === true;
	const label = uploading
		? `Uploading ${summary.active} ${summary.active === 1 ? "book" : "books"}`
		: `${summary.ready} to review`;
	const Glyph = GLYPHS[variant];
	const button = (
		<Button
			size="sm"
			className={styles.indicator}
			onClick={onOpen}
			aria-label={deadline ? `${label}. ${deadline.description}` : label}
			data-urgent={urgent || undefined}
		>
			{uploading ? (
				<UploadProgressRing progress={summary.progress} size={13} />
			) : (
				<Glyph className={styles.glyph} />
			)}
			<span className={styles.label}>{label}</span>
		</Button>
	);
	return deadline ? (
		<Tooltip label={deadline.description}>{button}</Tooltip>
	) : (
		button
	);
};
