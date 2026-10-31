import clsx from "clsx";
import styles from "./DropHalo.module.css";

export interface DropHaloProps {
	/** Gap between the halo and its positioned parent's edges, in px; negative wraps outside. */
	inset?: number;
	/** Corner radius in px, to follow the parent's corners. */
	radius?: number;
	className?: string;
}

/**
 * A hairline round its positioned parent with one warm light sweeping along
 * it: this whole area takes the drop.
 */
export const DropHalo = ({
	inset = 10,
	radius = 18,
	className,
}: DropHaloProps) => (
	<span
		className={clsx(styles.frame, className)}
		style={{ inset, borderRadius: radius }}
		aria-hidden="true"
	>
		<span className={clsx(styles.halo, styles.glow)} />
		<span className={styles.halo} />
	</span>
);
