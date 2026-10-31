import clsx from "clsx";
import { useRef } from "react";
import { StagedCover } from "@/components/atoms/StagedCover";
import { useCarouselScroll } from "@/lib/hooks/use-carousel-scroll";
import type { DepartingCover } from "@/lib/hooks/use-review-deck";
import type { QueueItem } from "@/lib/uploads/queue";
import styles from "./CoverCarousel.module.css";

export const AddedMotion = {
	/** The cover is dealt off to the left, onto an unseen pile. */
	deal: "deal",
	/** The cover drops and shrinks away, as if shelved. */
	shelve: "shelve",
	/** The cover lifts up and away. */
	lift: "lift",
} as const;
export type TAddedMotion = (typeof AddedMotion)[keyof typeof AddedMotion];

export interface CoverCarouselProps {
	items: QueueItem[];
	index: number;
	departing?: DepartingCover;
	motion?: TAddedMotion;
	onSelect: (index: number) => void;
}

const Cover = ({ item }: { item: QueueItem }) => (
	<StagedCover
		className={styles.cover}
		coverUrl={item.coverUrl}
		seed={item.book?.title ?? item.name}
	/>
);

/** The covers to draw: the ready books, with a departing one back in its place. */
const slides = (
	items: QueueItem[],
	departing: DepartingCover | undefined,
): { item: QueueItem; position?: number }[] => {
	const ready = items.map((item, position) => ({ item, position }));
	if (!departing || items.some((item) => item.key === departing.item.key))
		return ready;
	return [
		...ready.slice(0, departing.index),
		{ item: departing.item },
		...ready.slice(departing.index),
	];
};

/**
 * The ready books' covers in a row: the current one centred with its
 * neighbours either side. Swipe or tap a neighbour to move; an added or
 * skipped book's cover leaves and the row closes up behind it.
 */
export const CoverCarousel = ({
	items,
	index,
	departing,
	motion = AddedMotion.deal,
	onSelect,
}: CoverCarouselProps) => {
	const trackRef = useRef<HTMLDivElement>(null);
	useCarouselScroll({
		track: trackRef,
		index,
		onSelect,
		paused: departing !== undefined,
	});
	return (
		<div className={styles.carousel} data-motion={motion}>
			<div
				ref={trackRef}
				className={styles.track}
				data-departing={departing ? true : undefined}
			>
				{slides(items, departing).map(({ item, position }) =>
					position === undefined ? (
						// The same element as the cover it was, so the row doesn't jump.
						// The last book's cover stays put while the review closes.
						<button
							key={item.key}
							type="button"
							tabIndex={-1}
							className={clsx(
								styles.slide,
								departing?.last ? styles.current : styles.departing,
							)}
							data-exit={departing?.last ? undefined : departing?.exit}
							aria-hidden="true"
						>
							<Cover item={item} />
						</button>
					) : (
						<button
							key={item.key}
							type="button"
							className={clsx(
								styles.slide,
								position === index && styles.current,
							)}
							data-slide-index={position}
							aria-label={
								position === index
									? `${item.book?.title ?? item.name}, book ${position + 1} of ${items.length}`
									: `Show ${item.book?.title ?? item.name}`
							}
							aria-current={position === index || undefined}
							onClick={() => onSelect(position)}
						>
							<Cover item={item} />
						</button>
					),
				)}
			</div>
		</div>
	);
};
