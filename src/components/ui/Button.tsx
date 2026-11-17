import clsx from "clsx";
import { forwardRef } from "react";
import styles from "./Button.module.css";

/**
 * Citadel's one button. Every text button is the same height, padding and
 * type size; only its role changes how it looks:
 * - default: bordered, for most actions
 * - primary: filled, for the default button: the one main action of a
 *   form, sheet or dialog, the one Return presses
 * - subtle: borderless, for quiet secondary actions (Cancel, Revert)
 * - danger: bordered with red text, for destructive actions; never the
 *   default button
 * An icon before the label is 14px with a 6px gap.
 */
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "default" | "primary" | "danger" | "subtle";
	fullWidth?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	(
		{
			variant = "default",
			fullWidth = false,
			className,
			type = "button",
			...rest
		},
		ref,
	) => (
		<button
			ref={ref}
			type={type}
			className={clsx(
				styles.button,
				styles[variant],
				fullWidth && styles.fullWidth,
				className,
			)}
			{...rest}
		/>
	),
);

Button.displayName = "Button";
