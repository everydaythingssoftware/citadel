import clsx from "clsx";
import styles from "./DownloadRing.module.css";

export type DownloadRingState =
	| { status: "idle" }
	/** `progress` is 0–1, or null when the size isn't known. */
	| { status: "downloading"; progress: number | null }
	| { status: "done" };

interface DownloadRingProps {
	state: DownloadRingState;
	/** Draw a stop square instead of the arrow while downloading. */
	showStop?: boolean;
	size?: number;
	className?: string;
}

const RADIUS = 7.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Safari's download button: a grey ring around an arrow that fills in as
 * the file arrives, and turns into a check only once it's done.
 */
export const DownloadRing = ({
	state,
	showStop = false,
	size = 18,
	className,
}: DownloadRingProps) => {
	const downloading = state.status === "downloading";
	const progress = downloading ? state.progress : null;
	return (
		<svg
			className={clsx(styles.ring, className)}
			data-status={state.status}
			data-indeterminate={(downloading && progress === null) || undefined}
			width={size}
			height={size}
			viewBox="0 0 18 18"
			aria-hidden="true"
		>
			<circle className={styles.track} cx="9" cy="9" r={RADIUS} />
			{downloading && (progress === null || progress > 0) && (
				<circle
					className={styles.arc}
					cx="9"
					cy="9"
					r={RADIUS}
					strokeDasharray={`${CIRCUMFERENCE * (progress ?? 0.25)} ${CIRCUMFERENCE}`}
					transform="rotate(-90 9 9)"
				/>
			)}
			{state.status === "done" ? (
				<path className={styles.mark} d="M5.9 9.2 8 11.2l4.1-4.4" />
			) : downloading && showStop ? (
				<rect
					className={styles.stop}
					x="6.6"
					y="6.6"
					width="4.8"
					height="4.8"
					rx="0.9"
				/>
			) : (
				<path className={styles.mark} d="M9 5.4v6.2M6.6 9.3 9 11.7l2.4-2.4" />
			)}
		</svg>
	);
};
