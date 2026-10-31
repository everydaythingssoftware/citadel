import { Hourglass, type THourglassStyle } from "@/components/atoms/Hourglass";
import { UploadProgressRing } from "@/components/atoms/UploadProgressRing";
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

/** Toolbar status for uploads carrying on while the sheet is closed. */
export const UploadIndicator = ({
	summary,
	countdown,
	hourglass,
	onOpen,
}: UploadIndicatorProps) => {
	if (summary.active === 0 && summary.ready === 0) return null;
	const label =
		summary.active > 0
			? `Uploading ${summary.active} ${summary.active === 1 ? "book" : "books"}`
			: `${summary.ready} to review`;
	return (
		<button
			type="button"
			className={styles.indicator}
			onClick={onOpen}
			aria-label={
				countdown && summary.active === 0
					? `${label}. ${countdown.description}`
					: label
			}
			data-urgent={(summary.active === 0 && countdown?.urgent) || undefined}
		>
			{summary.active > 0 ? (
				<UploadProgressRing progress={summary.progress} size={16} />
			) : (
				countdown && (
					<Hourglass
						variant={hourglass}
						fraction={countdown.fraction}
						urgent={countdown.urgent}
						size={16}
						label={countdown.description}
					/>
				)
			)}
			<span className={styles.label}>{label}</span>
		</button>
	);
};
