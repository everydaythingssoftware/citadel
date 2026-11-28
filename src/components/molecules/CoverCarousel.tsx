import clsx from "clsx";
import { useRef } from "react";
import { BookCover } from "@/components/atoms/BookCover";
import { useCarouselScroll } from "@/lib/hooks/use-carousel-scroll";
import type { DepartingCover } from "@/lib/hooks/use-review-deck";
import type { QueueItem } from "@/lib/uploads/queue";
import { reviewCovers } from "@/lib/uploads/review-covers";
import styles from "./CoverCarousel.module.css";

export interface CoverCarouselProps {
	items: QueueItem[];
	index: number;
	departing?: DepartingCover;
	onSelect: (index: number) => void;
}

/**
 * The ready books' covers in a row: the current one centred with its
 * neighbours either side. Swipe or tap a neighbour to move; an added or
 * skipped book's cover leaves and the row closes up behind it.
 */
export const CoverCarousel = ({
	items,
	index,
	departing,
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
		<div className={styles.carousel}>
			<div
				ref={trackRef}
				className={styles.track}
				data-departing={departing ? true : undefined}
			>
				{reviewCovers(items, departing).map(({ item, position }) => {
					const exiting = position === undefined;
					return (
						<button
							key={item.key}
							type="button"
							className={clsx(
								styles.slide,
								(exiting || position === index) && styles.current,
								exiting && !departing?.last && styles.departing,
							)}
							data-slide-index={position}
							tabIndex={exiting ? -1 : undefined}
							aria-hidden={exiting || undefined}
							aria-label={
								position === index
									? `${item.book?.title ?? item.name}, book ${position + 1} of ${items.length}`
									: `Show ${item.book?.title ?? item.name}`
							}
							aria-current={(!exiting && position === index) || undefined}
							onClick={
								position === undefined ? undefined : () => onSelect(position)
							}
						>
							<BookCover
								alt=""
								provisional
								maxHeight="calc(var(--cover-width) * 1.5)"
								className={styles.cover}
								src={item.coverUrl}
								title={item.book?.title ?? item.name}
								exit={exiting && !departing?.last ? departing?.exit : undefined}
							/>
						</button>
					);
				})}
			</div>
		</div>
	);
};
