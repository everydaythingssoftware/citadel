import clsx from "clsx";
import { type ReactNode, useRef } from "react";
import styles from "./Reveal.module.css";

export interface RevealProps {
	/** Shown; changing it opens or closes the content smoothly. */
	open: boolean;
	/**
	 * Changes when the content stands for something else (another book):
	 * it then shows as it is at once, with no opening or closing.
	 */
	resetKey?: string;
	className?: string;
	children: ReactNode;
}

/**
 * Content that comes and goes with an edit, opening and closing its height
 * rather than popping in or out in one frame. Closed, it's inert.
 */
export const Reveal = ({
	open,
	resetKey,
	className,
	children,
}: RevealProps) => {
	const shownFor = useRef(resetKey);
	const reset = shownFor.current !== resetKey;
	shownFor.current = resetKey;
	return (
		<div
			className={clsx(styles.reveal, className)}
			data-open={open || undefined}
			data-instant={reset || undefined}
			inert={!open}
		>
			<div className={styles.inner}>{children}</div>
		</div>
	);
};
