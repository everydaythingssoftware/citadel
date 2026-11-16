import clsx from "clsx";
import { cloneElement, isValidElement, useId } from "react";
import styles from "./FormField.module.css";

export interface FormFieldProps {
	label: string;
	/** 11px helper text below the label. */
	description?: React.ReactNode;
	/** Validation message; renders in the danger color and sets aria-invalid. */
	error?: React.ReactNode;
	/** The control. A single element gets id / aria-describedby injected. */
	children: React.ReactNode;
	/** Override the generated control id (must match the control's own id). */
	id?: string;
	className?: string;
}

/**
 * Labeled-field wrapper for stacked forms: label, optional description,
 * the control, and optional error text, wired together for assistive tech.
 */
export const FormField = ({
	label,
	description,
	error,
	children,
	id,
	className,
}: FormFieldProps) => {
	const fallbackId = useId();
	const controlId = id ?? fallbackId;
	const hasError = error !== undefined && error !== null && error !== false;
	const descriptionId = `${controlId}-description`;
	const errorId = `${controlId}-error`;

	const describedBy =
		clsx(description && descriptionId, hasError && errorId) || undefined;

	const control = isValidElement<{
		id?: string;
		"aria-describedby"?: string;
		"aria-invalid"?: boolean;
	}>(children)
		? cloneElement(children, {
				id: children.props.id ?? controlId,
				"aria-describedby":
					clsx(children.props["aria-describedby"], describedBy) || undefined,
				"aria-invalid": hasError || children.props["aria-invalid"] || undefined,
			})
		: children;

	return (
		<div className={clsx(styles.field, className)}>
			<label className={styles.label} htmlFor={controlId}>
				{label}
			</label>
			{description && (
				<div id={descriptionId} className={styles.description}>
					{description}
				</div>
			)}
			{control}
			{hasError && (
				<div id={errorId} className={styles.error} data-selectable>
					{error}
				</div>
			)}
		</div>
	);
};
