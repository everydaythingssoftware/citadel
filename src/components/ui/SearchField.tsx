import clsx from "clsx";
import { forwardRef, useId } from "react";
import type { ContextMenuButton } from "@/lib/hooks/use-context-menu";
import styles from "./SearchField.module.css";

/** A message in the callout under the field. */
export interface SearchFieldMessage {
	tone: "error" | "hint";
	text: string;
}

/**
 * A scoped-filter token rendered inside the field, macOS token-field style
 * (Finder/Mail). Tokens sit between the magnifier and the text input, so
 * future filter kinds (tags, …) stack in the same place.
 */
export interface SearchFieldToken {
	label: string;
	onRemove: () => void;
	/** Optional hover explanation for the token. */
	title?: string;
}

export type SearchFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
	tokens?: SearchFieldToken[];
	/**
	 * The text of the callout under the field. The callout joins
	 * `aria-describedby`. An error tone sets `aria-invalid`, and the caller
	 * cannot clear it.
	 */
	message?: SearchFieldMessage;
	/** Shows the search scope button next to the magnifier, with these props. */
	scopeButton?: ContextMenuButton;
};

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
	(
		{
			className,
			tokens,
			message,
			scopeButton,
			onKeyDown,
			"aria-describedby": describedBy,
			...rest
		},
		ref,
	) => {
		const messageId = useId();
		return (
			<span
				className={clsx(
					styles.wrapper,
					scopeButton && styles.withScope,
					className,
				)}
			>
				<svg
					className={styles.magnifier}
					width="12"
					height="12"
					viewBox="0 0 15 15"
					fill="none"
					aria-hidden="true"
				>
					<circle
						cx="6.5"
						cy="6.5"
						r="4.5"
						stroke="currentColor"
						strokeWidth="1.4"
					/>
					<path
						d="M10 10l3.5 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
					/>
				</svg>
				{scopeButton && (
					<button
						type="button"
						className={styles.scopeButton}
						aria-label="Search scope"
						{...scopeButton}
					>
						<svg
							width="7"
							height="5"
							viewBox="0 0 9 6"
							fill="none"
							aria-hidden="true"
						>
							<path
								d="M1 1l3.5 3.5L8 1"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				)}
				{tokens?.map((token) => (
					<span key={token.label} className={styles.token} title={token.title}>
						{token.label}
						<button
							type="button"
							aria-label={`Remove filter ${token.label}`}
							className={styles.tokenRemove}
							onClick={token.onRemove}
						>
							<svg
								width="7"
								height="7"
								viewBox="0 0 9 9"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M1.5 1.5l6 6M7.5 1.5l-6 6"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
								/>
							</svg>
						</button>
					</span>
				))}
				<input
					ref={ref}
					type="search"
					className={styles.input}
					aria-describedby={
						message
							? [describedBy, messageId].filter(Boolean).join(" ")
							: describedBy
					}
					onKeyDown={(event) => {
						// Backspace in an empty input removes the last token, like
						// a native NSTokenField.
						if (event.key === "Backspace" && event.currentTarget.value === "") {
							tokens?.at(-1)?.onRemove();
						}
						onKeyDown?.(event);
					}}
					{...rest}
					aria-invalid={message?.tone === "error" ? true : rest["aria-invalid"]}
				/>
				<span
					id={messageId}
					className={styles.message}
					data-tone={message?.tone}
					aria-live="polite"
				>
					{message?.text}
				</span>
			</span>
		);
	},
);

SearchField.displayName = "SearchField";
