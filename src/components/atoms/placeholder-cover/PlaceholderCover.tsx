import type { CSSProperties } from "react";
import { motifCover, type MotifShape } from "./cover-motif";

import { selectByStringHash } from "@/lib/hash-string";
import { shortenToChars } from "@/lib/domain/book";
import img1Url from "../../../assets/1.jpg";
import img2Url from "../../../assets/2.jpg";
import img3Url from "../../../assets/3.jpg";
import img4Url from "../../../assets/4.jpg";
import img5Url from "../../../assets/5.jpg";
import styles from "../BookCover.module.css";

const TitledArtwork = ({
	title,
	authors,
}: {
	title: string;
	authors: string;
}) => (
	<>
		<img
			className={styles.painting}
			alt="App-provided placeholder cover."
			src={selectByStringHash(
				[img1Url, img2Url, img3Url, img4Url, img5Url],
				title,
			)}
		/>
		<div className={styles.caption}>
			<div className={styles.title}>{shortenToChars(title, 36)}</div>
			<div className={styles.author}>{authors}</div>
		</div>
	</>
);

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

const GeometricArtwork = ({ title }: { title: string }) => {
	const cover = motifCover(title);
	return (
		<div className={styles.motif} style={{ background: cover.background }}>
			{cover.shapes.map((shape, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed order per seed
				<span key={index} className={styles.shape} style={shapeStyle(shape)} />
			))}
		</div>
	);
};

export const PlaceholderCover = ({
	title,
	authors,
	showTitle,
}: {
	title: string;
	authors: string;
	showTitle: boolean;
}) =>
	!showTitle ? (
		<GeometricArtwork title={title} />
	) : (
		<TitledArtwork title={title} authors={authors} />
	);
