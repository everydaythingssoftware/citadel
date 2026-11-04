import clsx from "clsx";
import { forwardRef, useId } from "react";
import styles from "./TextInput.module.css";

export type TextInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
	label?: string;
	/** Help text rendered below the field and read out with it. */
	hint?: string;
	/** Validation message rendered below the field. */
	error?: React.ReactNode;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
	(
		{
			label,
			hint,
			error,
			className,
			id,
			"aria-describedby": ariaDescribedby,
			...rest
		},
		ref,
	) => {
		const fallbackId = useId();
		const inputId = id ?? fallbackId;
		const hasError = error !== undefined && error !== null && error !== false;
		const errorId = `${inputId}-error`;
		const hintId = `${inputId}-hint`;

		const input = (
			<input
				ref={ref}
				id={inputId}
				className={clsx(styles.input, hasError && styles.inputError, className)}
				aria-invalid={hasError || undefined}
				aria-describedby={
					clsx(ariaDescribedby, hint && hintId, hasError && errorId) ||
					undefined
				}
				{...rest}
			/>
		);

		if (!label && !hint && !hasError) {
			return input;
		}

		return (
			<div className={styles.field}>
				{label && (
					<label className={styles.label} htmlFor={inputId}>
						{label}
					</label>
				)}
				{input}
				{hint && (
					<div id={hintId} className={styles.hint}>
						{hint}
					</div>
				)}
				{hasError && (
					<div id={errorId} className={styles.error}>
						{error}
					</div>
				)}
			</div>
		);
	},
);

TextInput.displayName = "TextInput";
