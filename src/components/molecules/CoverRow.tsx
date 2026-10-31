import clsx from "clsx";
import { type CSSProperties, useMemo, useRef } from "react";
import { StagedCover } from "@/components/atoms/StagedCover";
import { type CoverRowParams, DEFAULT_COVER_ROW } from "@/lib/cover-row";
import { useCoverRow } from "@/lib/hooks/use-cover-row";
import type { DepartingCover } from "@/lib/hooks/use-review-deck";
import type { QueueItem } from "@/lib/uploads/queue";
import { AddedMotion, type TAddedMotion } from "./CoverCarousel";
import styles from "./CoverRow.module.css";

export interface CoverRowProps {
	items: QueueItem[];
	index: number;
	departing?: DepartingCover;
	motion?: TAddedMotion;
	onSelect: (index: number) => void;
	/** Tuning, over the defaults. */
	params?: Partial<CoverRowParams>;
}

const titleOf = (item: QueueItem) => item.book?.title ?? item.name;

const Art = ({ item }: { item: QueueItem }) => (
	<StagedCover
		className={styles.art}
		coverUrl={item.coverUrl}
		seed={titleOf(item)}
	/>
);

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
	motion = AddedMotion.deal,
	onSelect,
	params,
}: CoverRowProps) => {
	const stageRef = useRef<HTMLDivElement>(null);
	const tuned = useMemo(() => ({ ...DEFAULT_COVER_ROW, ...params }), [params]);
	const keys = items.map((item) => item.key);
	useCoverRow({ stage: stageRef, keys, index, onSelect, params: tuned });
	const gone =
		departing !== undefined &&
		!items.some((item) => item.key === departing.item.key);
	return (
		<div
			ref={stageRef}
			className={styles.row}
			data-motion={motion}
			style={{ "--cover-width": `${tuned.coverWidth}px` } as CSSProperties}
		>
			{items.map((item, position) => (
				<button
					key={item.key}
					type="button"
					className={styles.cover}
					data-cover-index={position}
					tabIndex={position === index ? 0 : -1}
					aria-current={position === index || undefined}
					aria-label={
						position === index
							? `${titleOf(item)}, book ${position + 1} of ${items.length}`
							: `Show ${titleOf(item)}`
					}
					onClick={() => onSelect(position)}
				>
					<Art item={item} />
				</button>
			))}
			{gone && (
				// The last book stays put while the review closes; any other
				// leaves from the middle as the next one glides in.
				<div
					className={clsx(styles.cover, !departing.last && styles.departing)}
					data-exit={departing.last ? undefined : departing.exit}
					aria-hidden="true"
				>
					<Art item={departing.item} />
				</div>
			)}
		</div>
	);
};
