import clsx from "clsx";
import type { CSSProperties } from "react";
import painting1 from "@/assets/1.jpg";
import painting2 from "@/assets/2.jpg";
import painting3 from "@/assets/3.jpg";
import styles from "./CoverFan.module.css";

const COVERS = [
	{ colour: "oklch(42% 0.08 30)", painting: painting2 },
	{ colour: "oklch(35% 0.05 160)", painting: painting3 },
	{ colour: "oklch(38% 0.06 250)", painting: painting1 },
] as const;

export interface CoverFanProps {
	/** Width of the front cover in px; the fan scales with it. */
	size?: number;
	className?: string;
}

/**
 * Three books fanned out (back-left, back-right, then the front), Citadel's
 * placeholder paintings tinted into cloth colours.
 */
export const CoverFan = ({ size = 128, className }: CoverFanProps) => (
	<div
		className={clsx(styles.fan, className)}
		style={{ "--fan-size": `${size}px` } as CSSProperties}
		aria-hidden="true"
	>
		{COVERS.map((cover, index) => (
			<div
				key={cover.colour}
				className={clsx(
					styles.book,
					[styles.left, styles.right, styles.front][index],
				)}
				style={{ background: cover.colour }}
			>
				<img className={styles.painting} src={cover.painting} alt="" />
				<span className={styles.spine} />
			</div>
		))}
	</div>
);
