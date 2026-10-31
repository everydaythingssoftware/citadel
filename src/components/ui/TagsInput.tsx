import clsx from "clsx";
import {
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useVisibleViewport } from "@/lib/hooks/use-visible-viewport";
import {
	type ListPlacement,
	placeList,
	visibleArea,
} from "@/lib/list-placement";
import { exactMatchIndex, rankSuggestions } from "@/lib/suggestions";
import { POPOVER_ATTRIBUTE } from "./popover-interop";
import styles from "./TagsInput.module.css";

const inBody = (list: React.ReactNode) => createPortal(list, document.body);

/** The nearest ancestor that clips vertically, which an attached list must fit inside. */
const scrollContainer = (element: HTMLElement): HTMLElement | undefined => {
	for (
		let parent = element.parentElement;
		parent;
		parent = parent.parentElement
	) {
		if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY))
			return parent;
	}
	return undefined;
};

export interface TagsInputProps {
	value: string[];
	onChange: (next: string[]) => void;
	suggestions?: string[];
	placeholder?: string;
	label?: string;
	"aria-label"?: string;
	/** Validation message rendered below the field. */
	error?: React.ReactNode;
	disabled?: boolean;
	id?: string;
	className?: string;
}

/**
 * An NSTokenField: committed values render as capsule tokens inside the
 * field, and typing two or more characters shows completions, best first.
 * Comma commits what was typed; Enter commits a completion only once one is
 * chosen with the arrows (or typed exactly), otherwise what was typed.
 * Follows the WAI-ARIA combobox/listbox pattern.
 */
export const TagsInput = ({
	value,
	onChange,
	suggestions = [],
	placeholder,
	label,
	"aria-label": ariaLabel,
	error,
	disabled = false,
	id,
	className,
}: TagsInputProps) => {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	const listboxId = `${inputId}-listbox`;
	const errorId = `${inputId}-error`;
	const hasError = error !== undefined && error !== null && error !== false;

	const inputRef = useRef<HTMLInputElement>(null);
	const fieldRef = useRef<HTMLDivElement>(null);
	const highlightedRef = useRef<HTMLDivElement>(null);

	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	// -1: nothing chosen, so Enter commits what was typed.
	const [highlight, setHighlight] = useState(-1);
	const [listRect, setListRect] = useState<ListPlacement | null>(null);
	const viewport = useVisibleViewport();
	// Inside a modal dialog, and on touch screens, the list is attached to
	// its field within whatever scrolls: a body portal sits outside a modal's
	// scroll lock, so neither touch nor wheel could scroll it. Elsewhere it
	// floats over everything.
	const [inDialog, setInDialog] = useState(false);
	useLayoutEffect(() => {
		setInDialog(fieldRef.current?.closest('[role="dialog"]') != null);
	}, []);
	const attached = viewport.touch || inDialog;
	const cramped = viewport.cramped;

	const filtered = useMemo(
		() => rankSuggestions(suggestions, value, query),
		[suggestions, value, query],
	);

	const listVisible = open && !disabled && filtered.length > 0;
	const highlightIndex = Math.min(highlight, filtered.length - 1);

	// The list stays within the visible screen (above an on-screen keyboard)
	// and never covers its field, flipping above it when that has more room.
	// Floating, it renders in a body portal with fixed positioning, escaping
	// scrolling ancestors instead of being clipped by them or stretching them
	// into scrolling; attached, it's measured against its scroll container.
	// Re-measure on any scroll/resize (of the page or the visual viewport)
	// and when typing rewraps the token field.
	// biome-ignore lint/correctness/useExhaustiveDependencies: query/value.length only trigger re-measures.
	useLayoutEffect(() => {
		if (!listVisible) {
			setListRect(null);
			return;
		}
		const update = () => {
			const field = fieldRef.current;
			const rect = field?.getBoundingClientRect();
			if (!field || !rect) return;
			// Attached, the list must fit its scroll container, measured in
			// the same coordinates as the field. (Mixing in the visual
			// viewport's offset misplaced it on iOS once the page had panned
			// for the keyboard, hiding the list entirely.)
			const bounds = attached
				? (scrollContainer(field)?.getBoundingClientRect() ?? {
						top: 0,
						bottom: window.innerHeight,
					})
				: visibleArea();
			setListRect(
				placeList(
					rect,
					{ top: bounds.top, bottom: bounds.bottom },
					{ preferAbove: cramped },
				) ?? null,
			);
		};
		update();
		const viewport = window.visualViewport;
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		viewport?.addEventListener("resize", update);
		viewport?.addEventListener("scroll", update);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			viewport?.removeEventListener("resize", update);
			viewport?.removeEventListener("scroll", update);
		};
	}, [listVisible, query, value.length, attached, cramped]);

	// Keep the highlighted option scrolled into view.
	useEffect(() => {
		if (listVisible) {
			highlightedRef.current?.scrollIntoView({ block: "nearest" });
		}
	}, [listVisible]);

	const addToken = (raw: string) => {
		const text = raw.trim();
		if (!text) return false;
		// Dedupe case-insensitively against committed tokens.
		if (value.some((v) => v.toLowerCase() === text.toLowerCase())) {
			setQuery("");
			setOpen(false);
			return true;
		}
		// Prefer the suggestion's canonical casing for free-typed matches.
		const canonical =
			suggestions.find((s) => s.toLowerCase() === text.toLowerCase()) ?? text;
		onChange([...value, canonical]);
		setQuery("");
		setOpen(false);
		setHighlight(-1);
		return true;
	};

	const removeToken = (token: string) => {
		onChange(value.filter((v) => v !== token));
	};

	const commitChosen = () => {
		const chosen =
			listVisible && highlightIndex >= 0 ? filtered[highlightIndex] : undefined;
		return addToken(chosen ?? query);
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		switch (event.key) {
			case "Enter":
				if (listVisible || query.trim() !== "") {
					event.preventDefault();
					commitChosen();
				}
				break;
			case ",":
				// A comma ends what was typed, never swaps in a suggestion.
				event.preventDefault();
				addToken(query);
				break;
			case "ArrowDown":
				event.preventDefault();
				if (!listVisible) {
					setOpen(true);
				} else {
					setHighlight(Math.min(highlightIndex + 1, filtered.length - 1));
				}
				break;
			case "ArrowUp":
				if (listVisible) {
					event.preventDefault();
					// Above the first completion is back to what was typed.
					setHighlight(Math.max(highlightIndex - 1, -1));
				}
				break;
			case "Escape":
				if (listVisible) {
					// Close only the completion list, not an enclosing dialog.
					event.preventDefault();
					event.stopPropagation();
					setOpen(false);
				}
				break;
			case "Backspace": {
				const last = value[value.length - 1];
				if (query === "" && last !== undefined) {
					event.preventDefault();
					removeToken(last);
				}
				break;
			}
			default:
				break;
		}
	};

	const control = (
		<div className={styles.control}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: click-anywhere-to-focus convenience; the inner input is the real interactive element. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
			<div
				ref={fieldRef}
				className={clsx(
					styles.field,
					hasError && styles.fieldError,
					disabled && styles.fieldDisabled,
				)}
				onClick={() => inputRef.current?.focus()}
			>
				{value.map((token) => (
					<span key={token} className={styles.token}>
						<span className={styles.tokenText}>{token}</span>
						{!disabled && (
							<button
								type="button"
								className={styles.tokenRemove}
								aria-label={`Remove ${token}`}
								// Keep focus in the input so blur does not commit
								// a half-typed entry before this click lands.
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => removeToken(token)}
							>
								<svg
									width="7"
									height="7"
									viewBox="0 0 7 7"
									fill="none"
									aria-hidden="true"
								>
									<path
										d="M1 1l5 5M6 1L1 6"
										stroke="currentColor"
										strokeWidth="1.2"
										strokeLinecap="round"
									/>
								</svg>
							</button>
						)}
					</span>
				))}
				<input
					ref={inputRef}
					id={inputId}
					className={styles.input}
					type="text"
					role="combobox"
					aria-expanded={listVisible}
					aria-controls={listboxId}
					aria-autocomplete="list"
					aria-activedescendant={
						listVisible && highlightIndex >= 0
							? `${listboxId}-opt-${highlightIndex}`
							: undefined
					}
					aria-label={label ? undefined : ariaLabel}
					aria-invalid={hasError || undefined}
					aria-describedby={hasError ? errorId : undefined}
					placeholder={value.length === 0 ? placeholder : undefined}
					disabled={disabled}
					value={query}
					onChange={(event) => {
						const typed = event.target.value;
						setQuery(typed);
						setOpen(true);
						setHighlight(
							exactMatchIndex(
								rankSuggestions(suggestions, value, typed),
								typed,
							),
						);
					}}
					onKeyDown={handleKeyDown}
					onBlur={() => {
						// Commit pending free text so a type-then-click-Save flow
						// does not silently drop the last entry.
						addToken(query);
						setOpen(false);
					}}
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			</div>
			{/* ARIA combobox pattern: focus stays on the input and aria-activedescendant tracks the option, so the listbox itself is not focusable. */}
			{listVisible &&
				listRect &&
				(attached ? (list: React.ReactNode) => list : inBody)(
					<div
						id={listboxId}
						role="listbox"
						aria-label={label ?? ariaLabel ?? "Suggestions"}
						className={clsx(styles.listbox, attached && styles.listboxAttached)}
						{...{ [POPOVER_ATTRIBUTE]: "" }}
						style={
							attached
								? {
										maxHeight: listRect.maxHeight,
										...(listRect.above
											? { bottom: "calc(100% + 4px)" }
											: { top: "calc(100% + 4px)" }),
									}
								: {
										left: listRect.left,
										top: listRect.top,
										width: listRect.width,
										maxHeight: listRect.maxHeight,
										// Above the field, the list grows upwards from its edge.
										transform: listRect.above ? "translateY(-100%)" : undefined,
									}
						}
					>
						{filtered.map((suggestion, index) => (
							// biome-ignore lint/a11y/useFocusableInteractive: see listbox note above.
							// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection happens on the combobox input.
							<div
								key={suggestion}
								id={`${listboxId}-opt-${index}`}
								role="option"
								aria-selected={index === highlightIndex}
								ref={index === highlightIndex ? highlightedRef : undefined}
								className={clsx(
									styles.option,
									index === highlightIndex && styles.optionHighlighted,
								)}
								// preventDefault keeps focus on the input through the click.
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => addToken(suggestion)}
								onMouseMove={() => setHighlight(index)}
							>
								{suggestion}
							</div>
						))}
					</div>,
				)}
		</div>
	);

	if (!label && !hasError) {
		return className ? <div className={className}>{control}</div> : control;
	}

	return (
		<div className={clsx(styles.wrapper, className)}>
			{label && (
				<label className={styles.label} htmlFor={inputId}>
					{label}
				</label>
			)}
			{control}
			{hasError && (
				<div id={errorId} className={styles.error}>
					{error}
				</div>
			)}
		</div>
	);
};
