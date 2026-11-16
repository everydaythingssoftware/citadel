import clsx from "clsx";
import { forwardRef, useId } from "react";
import styles from "./Textarea.module.css";

export type TextareaProps =
	React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
		label?: string;
		/** Validation message rendered below the field. */
		error?: React.ReactNode;
	};

/** Multiline twin of TextInput: same field chrome, vertical resize. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
	(
		{
			label,
			error,
			className,
			id,
			"aria-describedby": ariaDescribedby,
			...rest
		},
		ref,
	) => {
		const fallbackId = useId();
		const textareaId = id ?? fallbackId;
		const hasError = error !== undefined && error !== null && error !== false;
		const errorId = `${textareaId}-error`;

		const textarea = (
			<textarea
				ref={ref}
				id={textareaId}
				className={clsx(
					styles.textarea,
					hasError && styles.textareaError,
					className,
				)}
				aria-invalid={hasError || undefined}
				aria-describedby={
					clsx(ariaDescribedby, hasError && errorId) || undefined
				}
				{...rest}
			/>
		);

		if (!label && !hasError) {
			return textarea;
		}

		return (
			<div className={styles.field}>
				{label && (
					<label className={styles.label} htmlFor={textareaId}>
						{label}
					</label>
				)}
				{textarea}
				{hasError && (
					<div id={errorId} className={styles.error} data-selectable>
						{error}
					</div>
				)}
			</div>
		);
	},
);

Textarea.displayName = "Textarea";
