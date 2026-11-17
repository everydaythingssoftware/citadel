import * as RadixSelect from "@radix-ui/react-select";
import clsx from "clsx";
import { MacPopUpChevrons } from "@/components/icons/MacPopUpChevrons";
import { useSelectMenuFit } from "@/lib/hooks/use-select-menu-fit";
import styles from "./Select.module.css";

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectProps {
	value: string;
	onChange: (value: string) => void;
	options: SelectOption[];
	placeholder?: string;
	disabled?: boolean;
	width?: number;
	"aria-label"?: string;
	id?: string;
	className?: string;
}

const CheckmarkIcon = () => (
	<svg
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M1.5 5.5L4 8l4.5-6"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const ScrollChevron = ({ direction }: { direction: "up" | "down" }) => (
	<svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
		<path
			d={direction === "up" ? "M1 4l3-3 3 3" : "M1 1l3 3 3-3"}
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

/**
 * Lists this short always fit on screen, so they get no scroll arrows: an
 * arrow that mounts scrolls the chosen item into view, re-clipping a menu
 * that only had to be shown whole (`useSelectMenuFit`).
 */
const SCROLL_ARROWS_FROM = 9;

/** An NSPopUpButton: the open menu overlays the trigger with the selected item aligned. */
export const Select = ({
	value,
	onChange,
	options,
	placeholder,
	disabled,
	width,
	"aria-label": ariaLabel,
	id,
	className,
}: SelectProps) => {
	const menu = useSelectMenuFit();
	const scrollArrows = options.length >= SCROLL_ARROWS_FROM;
	return (
		<RadixSelect.Root
			value={value}
			onValueChange={onChange}
			disabled={disabled}
			open={menu.open}
			onOpenChange={menu.onOpenChange}
		>
			<RadixSelect.Trigger
				id={id}
				aria-label={ariaLabel}
				className={clsx(styles.trigger, className)}
				style={width !== undefined ? { width } : undefined}
			>
				<span className={styles.value}>
					<RadixSelect.Value placeholder={placeholder} />
				</span>
				<span className={styles.chevron}>
					<MacPopUpChevrons />
				</span>
			</RadixSelect.Trigger>
			<RadixSelect.Portal>
				{/* Item-aligned positioning sizes the menu to cover the trigger. */}
				<RadixSelect.Content className={styles.content}>
					{scrollArrows && (
						<RadixSelect.ScrollUpButton className={styles.scrollButton}>
							<ScrollChevron direction="up" />
						</RadixSelect.ScrollUpButton>
					)}
					<RadixSelect.Viewport ref={menu.viewportRef}>
						{options.map((option) => (
							<RadixSelect.Item
								key={option.value}
								value={option.value}
								className={styles.item}
							>
								<RadixSelect.ItemIndicator className={styles.indicator}>
									<CheckmarkIcon />
								</RadixSelect.ItemIndicator>
								<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
							</RadixSelect.Item>
						))}
					</RadixSelect.Viewport>
					{scrollArrows && (
						<RadixSelect.ScrollDownButton className={styles.scrollButton}>
							<ScrollChevron direction="down" />
						</RadixSelect.ScrollDownButton>
					)}
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
};
