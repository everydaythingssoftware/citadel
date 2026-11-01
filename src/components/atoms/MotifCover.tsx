import clsx from "clsx";
import type { CSSProperties } from "react";
import { type MotifShape, motifCover } from "@/lib/covers/motif";
import styles from "./MotifCover.module.css";
import { CoverSpine } from "./CoverSpine";

export interface MotifCoverProps {
	/** Usually the book's title: the same seed always draws the same cover. */
	seed: string;
	className?: string;
}

const shapeStyle = (shape: MotifShape): CSSProperties => ({
	left: `${shape.left}%`,
	top: `${shape.top}%`,
	width: `${shape.width}%`,
	height: `${shape.height}%`,
	borderRadius: shape.radius,
	transform: shape.rotate ? `rotate(${shape.rotate}deg)` : undefined,
	clipPath: shape.clip,
	opacity: shape.opacity,
	...(shape.outline
		? { border: `2px solid ${shape.fill}` }
		: { background: shape.pattern ?? shape.fill }),
});

/** A generated cloth cover with one simple motif, for books without art. */
export const MotifCover = ({ seed, className }: MotifCoverProps) => {
	const cover = motifCover(seed);
	return (
		<div
			className={clsx(styles.cover, className)}
			style={{ background: cover.background }}
			data-motif={cover.motif}
		>
			{cover.shapes.map((shape, index) => (
				// Shapes are positional layers with no identity of their own.
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed order per seed
				<span key={index} className={styles.shape} style={shapeStyle(shape)} />
			))}
			<CoverSpine />
		</div>
	);
};
