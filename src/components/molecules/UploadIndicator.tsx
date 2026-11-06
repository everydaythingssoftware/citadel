import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
import { BookSparkleGlyph } from "@/components/icons/UploadGlyphs";
import { Button, Tooltip } from "@/components/ui";
import type { Countdown } from "@/lib/uploads/countdown";
import type { QueueSummary } from "@/lib/uploads/queue";
import styles from "./UploadIndicator.module.css";

export interface UploadIndicatorProps {
	summary: QueueSummary;
	/** The soonest deadline among ready books. */
	countdown?: Countdown;
	/** Books are read from this computer rather than uploaded. */
	local?: boolean;
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
	local = false,
	onOpen,
}: UploadIndicatorProps) => {
	if (summary.active === 0 && summary.ready === 0) return null;
	const uploading = summary.active > 0;
	const deadline = !uploading ? countdown : undefined;
	const urgent = deadline?.urgent === true;
	const label = uploading
		? `${local ? "Reading" : "Uploading"} ${summary.active} ${summary.active === 1 ? "book" : "books"}`
		: `${summary.ready} to review`;
	const button = (
		<Button
			className={styles.indicator}
			onClick={onOpen}
			aria-label={deadline ? `${label}. ${deadline.description}` : label}
			data-urgent={urgent || undefined}
		>
			{uploading ? (
				<UploadProgressRing progress={summary.progress} size={13} />
			) : (
				<BookSparkleGlyph className={styles.glyph} />
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
