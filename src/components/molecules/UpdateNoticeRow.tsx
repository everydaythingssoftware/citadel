import styles from "./UpdateNoticeRow.module.css";

export interface UpdateNoticeRowProps {
	/** "Citadel 1.4 is ready". */
	title: string;
	onRestart: () => void;
	onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
	onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/** An arrow rising out of a soft ink disc: quiet, in the sidebar's own ink. */
const UpdateReadyGlyph = () => (
	<svg
		className={styles.glyph}
		width="20"
		height="20"
		viewBox="0 0 20 20"
		fill="none"
		aria-hidden="true"
	>
		<circle className={styles.glyphDisc} cx="10" cy="10" r="9" />
		<circle className={styles.glyphRing} cx="10" cy="10" r="8.5" />
		<path
			d="M10 14.25V6.25M6.75 9.25L10 6l3.25 3.25"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

/**
 * The sidebar footer's update notice: what is ready and what to do. One
 * click restarts into the update, with no confirmation.
 */
export const UpdateNoticeRow = ({
	title,
	onRestart,
	onContextMenu,
	onKeyDown,
}: UpdateNoticeRowProps) => (
	<button
		type="button"
		className={styles.row}
		onClick={onRestart}
		onContextMenu={onContextMenu}
		onKeyDown={onKeyDown}
	>
		<UpdateReadyGlyph />
		<span className={styles.text}>
			<span className={styles.title}>{title}</span>
			<span className={styles.action}>Restart to Update</span>
		</span>
	</button>
);
