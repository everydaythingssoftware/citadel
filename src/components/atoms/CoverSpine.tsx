import styles from "./CoverSpine.module.css";

/**
 * The library's book spine: highlights and shading down a cover's left
 * edge. Lay it over a cover inside a positioned box that hugs the image.
 */
export const CoverSpine = () => <span className={styles.spine} aria-hidden />;
