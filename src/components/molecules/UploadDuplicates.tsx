import clsx from "clsx";
import { type MouseEvent, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui";
import type { DuplicateGroup, QueueItem } from "@/lib/uploads/queue";
import styles from "./UploadDuplicates.module.css";
import { Thumbnail } from "./UploadQueueRow";
import rowStyles from "./UploadQueueRow.module.css";

export interface UploadDuplicatesProps {
	groups: DuplicateGroup[];
	onSkip: (items: QueueItem[]) => void;
	onAddAnyway: (items: QueueItem[]) => void;
}

/** The duplicates among the books just read, a row per book to skip or add anyway. */
export const UploadDuplicates = ({
	groups,
	onSkip,
	onAddAnyway,
}: UploadDuplicatesProps) => {
	const listRef = useRef<HTMLUListElement>(null);
	const refocus = useRef<{ row: number; button: number; pointer: boolean }>(
		undefined,
	);

	useLayoutEffect(() => {
		const list = listRef.current;
		const left = refocus.current;
		refocus.current = undefined;
		if (!list || !left) return;
		list.children[Math.min(left.row, groups.length - 1)]
			?.querySelectorAll("button")
			[left.button]?.focus({ preventScroll: left.pointer });
	}, [groups]);

	/** Focus goes to the same button of the row that takes this one's place. */
	const decide =
		(row: number, button: number, act: () => void) => (event: MouseEvent) => {
			// The list keeps its height, so what's below stays off the pointer.
			const list = listRef.current;
			if (list)
				list.style.minHeight = `${Math.min(list.offsetHeight, list.parentElement?.clientHeight ?? 0)}px`;
			refocus.current = { row, button, pointer: event.detail > 0 };
			act();
		};

	return (
		<ul ref={listRef} className={styles.list} aria-label="Duplicates">
			{groups.map(({ key, items, message }, row) => {
				const item = items[0];
				if (!item) return null;
				const name = item.book?.title ?? item.name;
				const authors = item.book?.authorNames.join(", ");
				const format = item.book?.format.toUpperCase();
				return (
					<li key={key} className={clsx(rowStyles.row, styles.row)}>
						<Thumbnail item={item} />
						<div className={rowStyles.text}>
							<span className={rowStyles.name}>{name}</span>
							<span className={rowStyles.subtitle}>
								{[authors, format].filter(Boolean).join(", ")}
							</span>
							<span
								className={clsx(
									rowStyles.subtitle,
									rowStyles.danger,
									styles.message,
								)}
							>
								{message}
							</span>
						</div>
						<div className={clsx(rowStyles.trailing, styles.actions)}>
							<Button
								aria-label={`Skip ${name}`}
								onClick={decide(row, 0, () => onSkip(items))}
							>
								Skip
							</Button>
							<Button
								aria-label={`Add Anyway: ${name}`}
								onClick={decide(row, 1, () => onAddAnyway(items))}
							>
								Add Anyway
							</Button>
						</div>
					</li>
				);
			})}
		</ul>
	);
};
