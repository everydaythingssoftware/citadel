import styles from "./CoverSpine.module.css";

/** Binding shading and edge highlights, layered separately to preserve whites. */
export const CoverSpine = () => (
	<>
		<span className={styles.spine} aria-hidden />
		<span className={styles.edges} aria-hidden />
	</>
);
