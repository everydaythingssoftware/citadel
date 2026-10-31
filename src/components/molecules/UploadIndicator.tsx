import { Hourglass, type THourglassStyle } from "@/components/atoms/Hourglass";
import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
import { Button, Tooltip } from "@/components/ui";
import type { Countdown } from "@/lib/uploads/countdown";
import type { QueueSummary } from "@/lib/uploads/queue";
import styles from "./UploadIndicator.module.css";

export interface UploadIndicatorProps {
	summary: QueueSummary;
	/** The soonest deadline among ready books. */
	countdown?: Countdown;
	hourglass?: THourglassStyle;
	onOpen: () => void;
}

/**
 * Toolbar status for uploads carrying on while the sheet is closed: a
 * toolbar button like Add Book, showing upload progress or, once books wait
 * for review, how long is left to review them.
 */
export const UploadIndicator = ({
	summary,
	countdown,
	hourglass,
	onOpen,
}: UploadIndicatorProps) => {
	if (summary.active === 0 && summary.ready === 0) return null;
	const uploading = summary.active > 0;
	const label = uploading
		? `Uploading ${summary.active} ${summary.active === 1 ? "book" : "books"}`
		: `${summary.ready} to review`;
	const deadline = !uploading ? countdown : undefined;
	const button = (
		<Button
			size="sm"
			className={styles.indicator}
			onClick={onOpen}
			aria-label={deadline ? `${label}. ${deadline.description}` : label}
			data-urgent={deadline?.urgent || undefined}
		>
			{uploading ? (
				<UploadProgressRing progress={summary.progress} size={13} />
			) : (
				deadline && (
					<Hourglass
						variant={hourglass}
						fraction={deadline.fraction}
						urgent={deadline.urgent}
						size={13}
						label={deadline.description}
					/>
				)
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
