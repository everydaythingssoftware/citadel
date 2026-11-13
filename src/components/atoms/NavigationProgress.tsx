import styles from "./NavigationProgress.module.css";

interface NavigationProgressProps {
	visible: boolean;
}

/** A thin bar along the top of the page while the next page loads. */
export const NavigationProgress = ({ visible }: NavigationProgressProps) =>
	visible ? (
		<div className={styles.track} role="progressbar" aria-label="Loading page">
			<div className={styles.fill} />
		</div>
	) : null;
