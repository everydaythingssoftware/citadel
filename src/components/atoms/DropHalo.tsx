import clsx from "clsx";
import styles from "./DropHalo.module.css";

/**
 * A hairline round its positioned parent with one warm light sweeping along
 * it: this whole area takes the drop.
 */
export const DropHalo = () => (
	<span className={styles.frame} aria-hidden="true">
		<span className={clsx(styles.halo, styles.glow)} />
		<span className={styles.halo} />
	</span>
);
