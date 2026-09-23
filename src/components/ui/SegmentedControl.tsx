import * as ToggleGroup from "@radix-ui/react-toggle-group";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlItem {
	value: string;
	label: ReactNode;
	"aria-label"?: string;
	disabled?: boolean;
}

export interface SegmentedControlProps {
	value: string;
	onChange: (value: string) => void;
	items: SegmentedControlItem[];
	"aria-label"?: string;
	className?: string;
}

export const SegmentedControl = ({
	value,
	onChange,
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
			if (next) onChange(next);
		}}
		aria-label={ariaLabel}
		className={clsx(styles.root, className)}
	>
		{items.map((item) => (
			<ToggleGroup.Item
				key={item.value}
				value={item.value}
				aria-label={item["aria-label"]}
				disabled={item.disabled}
				className={styles.item}
			>
				{item.label}
			</ToggleGroup.Item>
		))}
	</ToggleGroup.Root>
);
