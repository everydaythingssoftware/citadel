import clsx from "clsx";
import {
	type CSSProperties,
	type HTMLAttributes,
	type ReactEventHandler,
	memo,
} from "react";
import { useCoverImage } from "@/lib/hooks/use-cover-image";
import { PlaceholderCover } from "./placeholder-cover/PlaceholderCover";
import styles from "./BookCover.module.css";

export const COVER_SHELF_HEIGHT = 230;

export interface BookCoverProps extends HTMLAttributes<HTMLDivElement> {
	src?: string | null;
	title?: string;
	alt?: string;
	authors?: string;
	/** The title comes from an import that is still under review. */
	provisional?: boolean;
	sizeHint?: { width: number; height: number };
	maxHeight?: number | string;
	selected?: boolean;
	finished?: boolean;
	loading?: boolean;
	exit?: "added" | "skipped";
	onImageError?: ReactEventHandler<HTMLImageElement>;
}

export const BookCover = memo(function BookCover({
	src,
	...props
}: BookCoverProps) {
	return <BookCoverContent key={src ?? "fallback"} src={src} {...props} />;
});

const BookCoverContent = ({
	src,
	title = "",
	alt = title,
	authors = "",
	provisional = false,
	sizeHint,
	maxHeight = COVER_SHELF_HEIGHT,
	selected = false,
	finished = false,
	loading = false,
	exit,
	onImageError,
	className,
	style,
	children,
	...props
}: BookCoverProps) => {
	const { imageSrc, size, onLoad, onError } = useCoverImage(
		src,
		sizeHint,
		onImageError,
	);
	const heightLimit =
		typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;
	const ratio = size ? size.width / size.height : 2 / 3;
	return (
		<div
			{...props}
			className={clsx(
				styles.cover,
				exit && styles.leaving,
				exit === "added" && styles.added,
				exit === "skipped" && styles.skipped,
				className,
			)}
			data-selected={selected || undefined}
			data-loading={loading || undefined}
			data-finished={finished || undefined}
			data-fallback={!imageSrc || undefined}
			data-interactive={
				Boolean(props.onClick || props.onPointerDown) || undefined
			}
			style={
				{
					...style,
					width: `min(100%, ${size ? `${size.width}px, ` : ""}calc(${heightLimit} * ${ratio}))`,
					aspectRatio: String(ratio),
					"--cover-max-height": heightLimit,
				} as CSSProperties
			}
		>
			<div className={styles.surface}>
				{!loading && (
					<>
						{children ??
							(imageSrc ? (
								<img
									className={styles.image}
									src={imageSrc}
									alt={alt}
									width={sizeHint?.width}
									height={sizeHint?.height}
									decoding="async"
									draggable={false}
									onError={onError}
									onLoad={onLoad}
								/>
							) : (
								<PlaceholderCover
									title={title}
									authors={authors}
									showTitle={!provisional && title.trim().length > 0}
								/>
							))}
						<span className={styles.spine} aria-hidden="true" />
						<span className={styles.edges} aria-hidden="true" />
						<span className={styles.readOverlay} aria-hidden="true" />
					</>
				)}
			</div>
		</div>
	);
};
