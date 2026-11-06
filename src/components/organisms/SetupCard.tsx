import clsx from "clsx";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CitadelMark } from "@/components/atoms/CitadelMark";
import { Button, Spinner } from "@/components/ui";
import { REVEAL_ANIMATE_MIN } from "@/lib/first-run/machine";
import styles from "./FirstRunFlow.module.css";

/*
 * The setup card the desktop's first run (CDL-19) and the browser's server
 * setup (CDL-39) share: one card on the window background, morphing between
 * states, plus the views and glyphs both flows show. Pure renderers of
 * (state, callbacks); the flows' machines and hooks own behaviour.
 */

const EXIT_MS = 280;
const ENTER_CLEANUP_MS = 340;

export const fmt = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, word: string) =>
	n === 1 ? word : `${word}s`;

/* ------------------------------- icons -------------------------------- */

export const ShelfMark = () => <CitadelMark />;

export const GlobeGlyph = () => (
	<svg
		width="13"
		height="13"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.4"
		strokeLinecap="round"
		aria-hidden="true"
	>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25M8 1.75C6.3 3.55 5.5 5.65 5.5 8s.8 4.45 2.5 6.25" />
	</svg>
);

export const FolderGlyph = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M1.5 4.4c0-1 .9-1.9 2-1.9h2.4c.5 0 1 .2 1.4.6l.9.9h4.3c1.1 0 2 .9 2 1.9v4.7c0 1-.9 1.9-2 1.9h-9c-1.1 0-2-.9-2-1.9z" />
	</svg>
);

export const WarnGlyph = () => (
	<svg
		width="13"
		height="13"
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M8 1.6c.5 0 1 .3 1.3.8l5.3 9.6c.5 1-.2 2.2-1.3 2.2H2.7c-1.1 0-1.8-1.2-1.3-2.2L6.7 2.4c.3-.5.8-.8 1.3-.8zM8 6a.7.7 0 0 0-.7.7v2.6a.7.7 0 0 0 1.4 0V6.7A.7.7 0 0 0 8 6zm0 5.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z" />
	</svg>
);

export const ChevronRight = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.7"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M6 3.5 10.5 8 6 12.5" />
	</svg>
);

export const ChevronLeft = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.7"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M10 3.5 5.5 8 10 12.5" />
	</svg>
);

export const BookGlyph = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M3 2.8C3 2.1 3.6 1.5 4.3 1.5h8.2v11.2H4.4c-.5 0-.9.2-1.4.5zM3 14.1c0-.6.6-1 1.4-1h8.1v1.9H4.3c-.7 0-1.3-.4-1.3-.9z" />
	</svg>
);

/* --------------------------- shared fragments --------------------------- */

export const BusyLabel = ({ text }: { text: string }) => (
	<span className={styles.busyLabel}>
		<Spinner size={13} />
		{text}
	</span>
);

export const ErrLine = ({ text }: { text: string }) => (
	<div className={styles.err}>
		<WarnGlyph />
		<span>{text}</span>
	</div>
);

export const BackButton = ({
	onClick,
	disabled = false,
	autoFocus = false,
}: {
	onClick: () => void;
	disabled?: boolean;
	autoFocus?: boolean;
}) => (
	<button
		type="button"
		className={styles.back}
		disabled={disabled}
		data-autofocus={autoFocus ? "true" : undefined}
		onClick={onClick}
	>
		<ChevronLeft />
		Back
	</button>
);

/* ------------------------------ card views ------------------------------ */

export interface ChooserViewProps {
	disabled: boolean;
	onAdopt: () => void;
	onStartNew: () => void;
	lede?: string;
	adoptDescription?: string;
	createDescription?: string;
	/** Choices offered ahead of the two general ones, such as libraries
	 * already found; the first takes focus. */
	found?: ReactNode;
}

export const ChooserView = ({
	disabled,
	onAdopt,
	onStartNew,
	lede = "Citadel keeps your books in a Calibre‑compatible library.",
	adoptDescription = "Open your existing library folder.",
	createDescription = "Create an empty library at ~/Citadel.",
	found,
}: ChooserViewProps) => (
	<>
		<div className={styles.mark} aria-hidden="true">
			<ShelfMark />
		</div>
		<h1 className={styles.title}>Set up your library</h1>
		<p className={styles.lede}>{lede}</p>
		<div className={styles.choices}>
			{found && (
				<>
					{found}
					<p className={styles.choicesLabel}>Or another folder</p>
				</>
			)}
			<button
				type="button"
				className={styles.choice}
				disabled={disabled}
				data-autofocus={found ? undefined : "true"}
				onClick={onAdopt}
			>
				<span className={styles.choiceIcon}>
					<FolderGlyph />
				</span>
				<span>
					<span className={styles.choiceTitle}>I have a Calibre library</span>
					<br />
					<span className={styles.choiceDesc}>{adoptDescription}</span>
				</span>
				<span className={styles.choiceChevron}>
					<ChevronRight />
				</span>
			</button>
			<button
				type="button"
				className={styles.choice}
				disabled={disabled}
				onClick={onStartNew}
			>
				<span className={styles.choiceIcon}>
					<BookGlyph />
				</span>
				<span>
					<span className={styles.choiceTitle}>Start a new library</span>
					<br />
					<span className={styles.choiceDesc}>{createDescription}</span>
				</span>
				<span className={styles.choiceChevron}>
					<ChevronRight />
				</span>
			</button>
		</div>
	</>
);

export interface RevealViewProps {
	books: number;
	authors: number;
	reduced: boolean;
	announce: (text: string) => void;
	onContinue: () => void;
}

/** Count-up per the prototype: ease-out cubic, books then authors, and the
 * settled counts announced once. Deliberately never auto-continues — the
 * moment is user-paced, and Return advances via the focused default. */
export const RevealView = ({
	books,
	authors,
	reduced,
	announce,
	onContinue,
}: RevealViewProps) => {
	const animate = !reduced && books >= REVEAL_ANIMATE_MIN;
	const [shown, setShown] = useState(() =>
		animate ? { books: 0, authors: 0 } : { books, authors },
	);

	useEffect(() => {
		const settled = `Library opened. ${fmt(books)} ${plural(books, "book")} by ${fmt(authors)} ${plural(authors, "author")}.`;
		if (!animate) {
			setShown({ books, authors });
			announce(settled);
			return;
		}
		let raf = 0;
		const start = performance.now();
		const eased = (now: number, duration: number, delay: number) => {
			const p = Math.min(1, Math.max(0, (now - start - delay) / duration));
			return 1 - (1 - p) ** 3;
		};
		const tick = (now: number) => {
			setShown({
				books: Math.round(books * eased(now, 550, 40)),
				authors: Math.round(authors * eased(now, 500, 160)),
			});
			if (now - start < 750) {
				raf = requestAnimationFrame(tick);
			} else {
				announce(settled);
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [books, authors, animate, announce]);

	return (
		<>
			<h1 className={clsx(styles.title, styles.titleSm)}>
				Your library is ready.
			</h1>
			<div className={styles.count}>
				{fmt(shown.books)} {plural(books, "book")}
			</div>
			<div className={styles.countSub}>
				by {fmt(shown.authors)} {plural(authors, "author")}
			</div>
			<div className={clsx(styles.actions, styles.revealActions)}>
				<Button
					variant="primary"
					fullWidth
					data-autofocus="true"
					onClick={onContinue}
				>
					Show Books
				</Button>
			</div>
		</>
	);
};

/* ------------------------------ morph card ------------------------------ */

export interface MorphCardProps {
	viewKey: string;
	label: string;
	hasBack: boolean;
	children: ReactNode;
}

interface GhostView {
	html: string;
	hasBack: boolean;
	fading: boolean;
}

/**
 * The one morphing card: cross-fades views (old fades out in place, new
 * slides up 6px) while the card height tweens to fit. A new morph cancels the
 * previous one — views never stack. Every morph moves focus to the incoming
 * view's `[data-autofocus]` control, or to the view container when nothing is
 * actionable, so focus never silently drops to `<body>`.
 */
export const MorphCard = ({
	viewKey,
	label,
	hasBack,
	children,
}: MorphCardProps) => {
	const innerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<HTMLDivElement>(null);
	/** Latest committed markup of the current view, snapshotted for the ghost. */
	const lastHtmlRef = useRef<{ html: string; hasBack: boolean } | null>(null);

	const [prevKey, setPrevKey] = useState(viewKey);
	const [ghost, setGhost] = useState<GhostView | null>(null);
	const [entering, setEntering] = useState<"pre" | "on" | null>(null);

	// Derived-state morph start: the outgoing view becomes a static ghost (its
	// last committed markup), and the incoming view remounts fresh. Starting a
	// new morph drops any still-fading ghost — views never stack.
	if (viewKey !== prevKey) {
		setPrevKey(viewKey);
		setGhost(lastHtmlRef.current && { ...lastHtmlRef.current, fading: false });
		setEntering("pre");
	}

	// Snapshot the current view's markup after every commit so the next morph
	// can fade out exactly what was on screen (a static, inert copy).
	useEffect(() => {
		if (viewRef.current) {
			lastHtmlRef.current = { html: viewRef.current.innerHTML, hasBack };
		}
	});

	// Height follows the current view (morphs and in-place growth alike).
	// biome-ignore lint/correctness/useExhaustiveDependencies: prevKey re-arms the observer on the freshly keyed view element
	useLayoutEffect(() => {
		const inner = innerRef.current;
		const view = viewRef.current;
		if (!inner || !view) return;
		const apply = () => {
			inner.style.height = `${view.offsetHeight}px`;
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(view);
		return () => observer.disconnect();
	}, [prevKey]);

	// Enter motion: mount at (opacity 0, +6px), release to settled next frame.
	useEffect(() => {
		if (entering === "pre") {
			const raf = requestAnimationFrame(() => setEntering("on"));
			return () => cancelAnimationFrame(raf);
		}
		if (entering === "on") {
			const timer = setTimeout(() => setEntering(null), ENTER_CLEANUP_MS);
			return () => clearTimeout(timer);
		}
	}, [entering]);

	// Exit motion: the ghost fades from the frame after it mounts, then goes.
	useEffect(() => {
		if (!ghost) return;
		if (!ghost.fading) {
			const raf = requestAnimationFrame(() =>
				setGhost((current) => current && { ...current, fading: true }),
			);
			return () => cancelAnimationFrame(raf);
		}
		const timer = setTimeout(() => setGhost(null), EXIT_MS);
		return () => clearTimeout(timer);
	}, [ghost]);

	// Focus choreography: on every morph (and first mount), focus the primary.
	// The first view's focus is the page's own doing, not the user's: no ring
	// until they reach for the keyboard. Later views follow how the user got
	// there.
	const firstFocus = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: prevKey re-runs the focus move for each incoming view
	useLayoutEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const target = view.querySelector<HTMLElement>(
			"[data-autofocus]:not(:disabled)",
		);
		(target ?? view).focus({
			preventScroll: true,
			focusVisible: firstFocus.current ? false : undefined,
		});
		firstFocus.current = false;
	}, [prevKey]);

	// If the primary was still disabled when the view mounted (e.g. create's
	// commit button before the default path resolves), pick it up as soon as
	// it enables — but only from the container fallback, never from a control
	// the user has since focused.
	useEffect(() => {
		const view = viewRef.current;
		if (!view || document.activeElement !== view) return;
		const target = view.querySelector<HTMLElement>(
			"[data-autofocus]:not(:disabled)",
		);
		target?.focus({ preventScroll: true });
	});

	return (
		<section className={styles.card} aria-label={label}>
			<div className={styles.cardInner} ref={innerRef}>
				{ghost && (
					<div
						className={clsx(
							styles.view,
							ghost.hasBack && styles.viewHasBack,
							ghost.fading && styles.viewExit,
						)}
						aria-hidden="true"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: inert snapshot of our own just-unmounted view, for the exit fade only
						dangerouslySetInnerHTML={{ __html: ghost.html }}
					/>
				)}
				<div
					key={prevKey}
					ref={viewRef}
					tabIndex={-1}
					className={clsx(
						styles.view,
						hasBack && styles.viewHasBack,
						entering !== null && styles.viewEnter,
						entering === "on" && styles.viewEnterOn,
					)}
				>
					{children}
				</div>
			</div>
		</section>
	);
};
