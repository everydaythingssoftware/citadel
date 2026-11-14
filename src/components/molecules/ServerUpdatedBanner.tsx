import styles from "./ServerUpdatedBanner.module.css";

export interface ServerUpdatedBannerProps {
	onReload: () => void;
	onDismiss: () => void;
}

/**
 * Top-right, like the toasts: the server under this page was updated.
 * Reloading is the only way a page updates, so this banner carries the action.
 */
export const ServerUpdatedBanner = ({
	onReload,
	onDismiss,
}: ServerUpdatedBannerProps) => (
	<div role="status" className={styles.banner}>
		<div className={styles.text}>
			<div className={styles.title}>Citadel was updated</div>
			<div className={styles.message}>Reload to get the latest version.</div>
			<button type="button" className={styles.reload} onClick={onReload}>
				Reload
			</button>
		</div>
		<button
			type="button"
			className={styles.dismiss}
			aria-label="Dismiss"
			onClick={onDismiss}
		>
			<svg
				width="8"
				height="8"
				viewBox="0 0 8 8"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M1 1l6 6M7 1L1 7"
					stroke="currentColor"
					strokeWidth="1.3"
					strokeLinecap="round"
				/>
			</svg>
		</button>
	</div>
);
