import clsx from "clsx";
import { CoverFan, type TCoverFanStyle } from "./CoverFan";
import styles from "./DropOverlay.module.css";

export interface DropOverlayProps {
	visible: boolean;
	fan?: TCoverFanStyle;
	/** Renders in place rather than over the window (stories, previews). */
	contained?: boolean;
}

/**
 * Covers the window while books are dragged over it: the library frosts over,
 * a brass light sweeps the edge to say the whole window takes the drop, and a
 * fan of books sits in the middle.
 */
export const DropOverlay = ({
	visible,
	fan,
	contained = false,
}: DropOverlayProps) => (
	<div
		className={clsx(
			styles.overlay,
			contained && styles.contained,
			visible && styles.visible,
		)}
		aria-hidden={!visible}
	>
		<div className={clsx(styles.halo, styles.glow)} />
		<div className={styles.halo} />
		<CoverFan variant={fan} size={128} />
		<div className={styles.copy}>
			<p className={styles.title}>Add to Library</p>
			<p className={styles.hint}>Drop to upload</p>
		</div>
	</div>
);
