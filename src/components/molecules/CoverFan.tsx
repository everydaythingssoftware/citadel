import clsx from "clsx";
import type { CSSProperties } from "react";
import painting1 from "@/assets/1.jpg";
import painting2 from "@/assets/2.jpg";
import painting3 from "@/assets/3.jpg";
import { MotifCover } from "@/components/atoms/MotifCover";
import styles from "./CoverFan.module.css";

export const CoverFanStyle = {
	/** Citadel's placeholder paintings, tinted into cloth colours. */
	paintings: "paintings",
	/** Generated motif covers. */
	motifs: "motifs",
	/** Flat cloth colours. */
	plain: "plain",
} as const;
export type TCoverFanStyle = (typeof CoverFanStyle)[keyof typeof CoverFanStyle];

const COVERS = [
	{ colour: "oklch(42% 0.08 30)", painting: painting2, seed: "Larkmoor" },
	{ colour: "oklch(35% 0.05 160)", painting: painting3, seed: "Fernhollow" },
	{ colour: "oklch(38% 0.06 250)", painting: painting1, seed: "Wivenhoe" },
] as const;

export interface CoverFanProps {
	variant?: TCoverFanStyle;
	/** Width of the front cover in px; the fan scales with it. */
	size?: number;
	className?: string;
}

/** Three books fanned out: back-left, back-right, then the front cover. */
export const CoverFan = ({
	variant = CoverFanStyle.paintings,
	size = 128,
	className,
}: CoverFanProps) => (
	<div
		className={clsx(styles.fan, className)}
		style={{ "--fan-size": `${size}px` } as CSSProperties}
		aria-hidden="true"
	>
		{COVERS.map((cover, index) => (
			<div
				key={cover.seed}
				className={clsx(
					styles.book,
					[styles.left, styles.right, styles.front][index],
				)}
				style={{ background: cover.colour }}
			>
				{variant === CoverFanStyle.paintings && (
					<img className={styles.painting} src={cover.painting} alt="" />
				)}
				{variant === CoverFanStyle.motifs && (
					<MotifCover className={styles.motif} seed={cover.seed} />
				)}
				<span className={styles.spine} />
			</div>
		))}
	</div>
);
