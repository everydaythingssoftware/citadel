import type { ReactNode } from "react";
import styles from "./NoBreak.module.css";

/**
 * Keeps a name on one line where it fits, so wrapping text never splits it;
 * a name wider than its container still wraps.
 */
export const NoBreak = ({ children }: { children: ReactNode }) => (
	<span className={styles.noBreak}>{children}</span>
);
