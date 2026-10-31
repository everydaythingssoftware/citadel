import clsx from "clsx";
import type { CSSProperties } from "react";
import { HoldState, useHoldToConfirm } from "@/lib/hooks/use-hold-to-confirm";
import styles from "./HoldButton.module.css";

export interface HoldButtonProps {
	label: string;
	/** Shown when it's clicked instead of held, e.g. "Hold to cancel all uploads". */
	hint: string;
	onConfirm: () => void;
	disabled?: boolean;
	holdMs?: number;
	className?: string;
}

/**
 * A destructive button that has to be held: a red fill grows from the
 * middle while it's held and the action happens when it's full. A click
 * shakes it and says to hold.
 */
export const HoldButton = ({
	label,
	hint,
	onConfirm,
	disabled = false,
	holdMs,
	className,
}: HoldButtonProps) => {
	const hold = useHoldToConfirm({ onConfirm, holdMs, disabled });
	return (
		<span className={clsx(styles.wrap, className)}>
			<button
				type="button"
				className={styles.button}
				data-state={hold.state === HoldState.idle ? undefined : hold.state}
				// Alternating between two identical shakes replays it on every
				// quick click without remounting (and losing focus).
				data-shake={
					hold.shakes === 0 ? undefined : hold.shakes % 2 ? "odd" : "even"
				}
				data-label={label}
				disabled={disabled}
				aria-label={`${label} (press and hold)`}
				style={{ "--hold-ms": `${hold.holdMs}ms` } as CSSProperties}
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
