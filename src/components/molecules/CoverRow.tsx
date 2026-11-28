import clsx from "clsx";
import { type CSSProperties, useRef } from "react";
import { BookCover } from "@/components/atoms/BookCover";
import { DEFAULT_COVER_ROW } from "@/lib/cover-row";
import { useCoverRow } from "@/lib/hooks/use-cover-row";
import type { DepartingCover } from "@/lib/hooks/use-review-deck";
import { isPdfFormat } from "@/lib/pdf-only";
import type { QueueItem } from "@/lib/uploads/queue";
import { reviewCovers } from "@/lib/uploads/review-covers";
import styles from "./CoverRow.module.css";

export interface CoverRowProps {
	items: QueueItem[];
	index: number;
	departing?: DepartingCover;
	onSelect: (index: number) => void;
}

const titleOf = (item: QueueItem) => item.book?.title ?? item.name;

/**
 * The ready books' covers in a row, with Cover Flow's feel: the current one
 * in the middle, its neighbours peeking in at the edges. Scroll with a
 * trackpad (a flick carries on through several), drag, or click a cover; it
 * settles on the nearest one, and the review follows the moment a cover
 * reaches the middle. An added or skipped book's cover leaves from the
 * middle.
 */
export const CoverRow = ({
	items,
	index,
	departing,
	onSelect,
}: CoverRowProps) => {
	const stageRef = useRef<HTMLDivElement>(null);
	const keys = items.map((item) => item.key);
	useCoverRow({
		stage: stageRef,
		keys,
		index,
		onSelect,
		params: DEFAULT_COVER_ROW,
	});
	return (
		<div
			ref={stageRef}
			className={styles.row}
			style={
				{
					"--cover-width": `${DEFAULT_COVER_ROW.coverWidth}px`,
				} as CSSProperties
			}
		>
			{reviewCovers(items, departing).map(({ item, position }) => {
				const exiting = position === undefined;
				return (
					<button
						key={item.key}
						type="button"
						className={clsx(
							styles.cover,
							exiting && !departing?.last && styles.departing,
						)}
						data-cover-index={position}
						tabIndex={!exiting && position === index ? 0 : -1}
						aria-hidden={exiting || undefined}
						aria-current={(!exiting && position === index) || undefined}
						aria-label={
							position === index
								? `${titleOf(item)}, book ${position + 1} of ${items.length}`
								: `Show ${titleOf(item)}`
						}
						onClick={
							position === undefined ? undefined : () => onSelect(position)
						}
					>
						<BookCover
							alt=""
							provisional
							maxHeight="calc(var(--cover-width) * 1.5)"
							className={styles.art}
							src={item.coverUrl}
							title={titleOf(item)}
							flat={isPdfFormat(item.book?.format)}
							exit={exiting && !departing?.last ? departing?.exit : undefined}
						/>
					</button>
				);
			})}
		</div>
	);
};
