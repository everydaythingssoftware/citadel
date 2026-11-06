import clsx from "clsx";
import styles from "./UploadProgressRing.module.css";

export interface UploadProgressRingProps {
	/** 0–1 of the file sent. */
	progress: number;
	/** Stops the upload; hovering the ring shows an × when set. */
	onStop?: () => void;
	/** e.g. "Stop uploading walden". */
	stopLabel?: string;
	size?: number;
	className?: string;
}

const CIRCUMFERENCE = 2 * Math.PI * 10;

/** Determinate ring that turns into a stop (×) button on hover. */
export const UploadProgressRing = ({
	progress,
	onStop,
	stopLabel = "Stop upload",
	size = 24,
	className,
}: UploadProgressRingProps) => {
	const value = Math.min(1, Math.max(0, progress));
	const percent = Math.round(value * 100);
	const ring = (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<circle className={styles.track} cx="12" cy="12" r="10" />
			{/* A zero-length arc still paints its round cap as a stray dot. */}
			{value > 0 && (
				<circle
					className={styles.arc}
					cx="12"
					cy="12"
					r="10"
					strokeDasharray={`${CIRCUMFERENCE * value} ${CIRCUMFERENCE}`}
					transform="rotate(-90 12 12)"
				/>
			)}
			{onStop && <path className={styles.stop} d="M9 9l6 6M15 9l-6 6" />}
		</svg>
	);
	return onStop ? (
		<button
			type="button"
			className={clsx(styles.ring, styles.button, className)}
			onClick={onStop}
			aria-label={`${stopLabel}, ${percent}% sent`}
		>
			{ring}
		</button>
	) : (
		<span
			className={clsx(styles.ring, className)}
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
		>
			{ring}
		</span>
	);
};
