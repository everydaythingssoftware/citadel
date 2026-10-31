import clsx from "clsx";
import { CoverSpine } from "./CoverSpine";
import { MotifCover } from "./MotifCover";
import styles from "./StagedCover.module.css";

export interface StagedCoverProps {
	/** The cover read from the book's file, if it had one. */
	coverUrl?: string | null;
	/** Seeds the motif cover drawn when there's no image. */
	seed: string;
	className?: string;
}

/**
 * An uploaded book's cover, shaded with the library's book spine down the
 * left edge, like every cover in the grid; books without one get a motif
 * cover, which has the same spine.
 */
export const StagedCover = ({ coverUrl, seed, className }: StagedCoverProps) =>
	coverUrl ? (
		<span className={clsx(styles.cover, className)}>
			<img className={styles.image} src={coverUrl} alt="" draggable={false} />
			<CoverSpine />
		</span>
	) : (
		<MotifCover className={className} seed={seed} />
	);
