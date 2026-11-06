import * as ToggleGroup from "@radix-ui/react-toggle-group";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./SegmentedControl.module.css";
import { Tooltip } from "./Tooltip";

export interface SegmentedControlItem {
	value: string;
	label: ReactNode;
	"aria-label"?: string;
	disabled?: boolean;
	/**
	 * Looks disabled but still takes hover and clicks, so it can say why: this
	 * text is its tooltip, and a click calls `onLockedClick` instead of selecting.
	 */
	lockedReason?: string;
}

export interface SegmentedControlProps {
	value: string;
	onChange: (value: string) => void;
	onLockedClick?: (value: string) => void;
	items: SegmentedControlItem[];
	"aria-label"?: string;
	className?: string;
}

export const SegmentedControl = ({
	value,
	onChange,
	onLockedClick,
	items,
	"aria-label": ariaLabel,
	className,
}: SegmentedControlProps) => (
	<ToggleGroup.Root
		type="single"
		value={value}
		onValueChange={(next) => {
			// Radix emits "" when the active segment is clicked again, but
			// NSSegmentedControl select-one never deselects, so swallow it.
			if (!next) return;
			if (items.some((item) => item.value === next && item.lockedReason)) {
				onLockedClick?.(next);
				return;
			}
			onChange(next);
		}}
		aria-label={ariaLabel}
		className={clsx(styles.root, className)}
	>
		{items.map((item) => {
			const segment = (
				<ToggleGroup.Item
					key={item.value}
					value={item.value}
					aria-label={item["aria-label"]}
					aria-disabled={item.lockedReason ? true : undefined}
					data-locked={item.lockedReason ? "" : undefined}
					disabled={item.disabled}
					className={styles.item}
				>
					{item.label}
				</ToggleGroup.Item>
			);
			return item.lockedReason ? (
				<Tooltip key={item.value} label={item.lockedReason} openDelay={200}>
					{segment}
				</Tooltip>
			) : (
				segment
			);
		})}
	</ToggleGroup.Root>
);
