import clsx from "clsx";
import type { CSSProperties } from "react";
import {
	HOLD_MS,
	HoldState,
	useHoldToConfirm,
} from "@/lib/hooks/use-hold-to-confirm";
import buttonStyles from "./Button.module.css";
import styles from "./HoldButton.module.css";

export interface HoldButtonProps {
	label: string;
	/** Shown when it's clicked instead of held, e.g. "Hold to cancel all uploads". */
	hint: string;
	onConfirm: () => void;
	/** Neutral for actions that replace something rather than destroy it. */
	tone?: "danger" | "neutral";
	disabled?: boolean;
	className?: string;
}

/**
 * A consequential button that has to be held: a fill, red unless neutral,
 * grows from the middle while it's held and the action happens when it's full. A click
 * shakes it and says to hold.
 */
export const HoldButton = ({
	label,
	hint,
	onConfirm,
	tone = "danger",
	disabled = false,
	className,
}: HoldButtonProps) => {
	const hold = useHoldToConfirm({ onConfirm, disabled });
	return (
		<span className={clsx(styles.wrap, className)}>
			<button
				type="button"
				// The standard bordered button; only the red text and the hold
				// fill are its own.
				className={clsx(
					buttonStyles.button,
					buttonStyles.default,
					styles.button,
				)}
				data-state={hold.state === HoldState.idle ? undefined : hold.state}
				// Alternating between two identical shakes replays it on every
				// quick click without remounting (and losing focus).
				data-shake={
					hold.shakes === 0 ? undefined : hold.shakes % 2 ? "odd" : "even"
				}
				data-label={label}
				data-tone={tone}
				disabled={disabled}
				aria-label={`${label} (press and hold)`}
				style={{ "--hold-ms": `${HOLD_MS}ms` } as CSSProperties}
				{...hold.handlers}
			>
				<span className={styles.label}>{label}</span>
			</button>
			{hold.hint && (
				<span className={styles.hint} role="status">
					{hint}
				</span>
			)}
		</span>
	);
};
