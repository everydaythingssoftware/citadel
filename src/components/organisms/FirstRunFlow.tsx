import clsx from "clsx";
import type { ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { DetectionSource } from "@/bindings";
import { FluentLibraryFilled } from "@/components/icons/FluentLibraryFilled";
import { Button, Spinner } from "@/components/ui";
import type {
	CreateError,
	FlowMode,
	FlowRoot,
	FlowSnapshot,
} from "@/lib/first-run/machine";
import {
	ADOPT_INVALID_ERROR,
	CREATE_EXISTING_ERROR,
	REVEAL_ANIMATE_MIN,
} from "@/lib/first-run/machine";
import type { FirstRunFlow } from "@/lib/hooks/use-first-run-flow";
import {
	useBootDecision,
	useFirstRunFlow,
} from "@/lib/hooks/use-first-run-flow";
import { abbreviateHomePath, useHomeDir } from "@/lib/hooks/use-home-dir";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import styles from "./FirstRunFlow.module.css";

/*
 * CDL-19 first-run onboarding: one card on the window background, morphing
 * between states. Visual contract: ai-docs/design/cdl-19-first-run/
 * morphing-card-improved.html (layout, copy, and motion transcribed
 * verbatim). Every component here is a pure renderer of (state, callbacks);
 * behavior lives in the flow machine and its hook.
 */

const EXIT_MS = 280;
const ENTER_CLEANUP_MS = 340;
const HANDOFF_MS = 420;

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/* ------------------------------- icons -------------------------------- */

const ShelfMark = () => (
	<FluentLibraryFilled fontSize={28} aria-hidden="true" />
);

const FolderGlyph = () => (
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

const CloudMark = () => (
	<svg
		width="26"
		height="26"
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M6.6 18.5a4.1 4.1 0 0 1-.6-8.2 5.5 5.5 0 0 1 10.7-1.1 4.7 4.7 0 0 1-.9 9.3z" />
	</svg>
);

const WarnGlyph = () => (
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

const CheckGlyph = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.8"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M3.2 8.6l3.1 3 6.5-7" />
	</svg>
);

const ChevronRight = () => (
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

const ChevronLeft = () => (
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

const BookGlyph = () => (
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

const BusyLabel = ({ text }: { text: string }) => (
	<span className={styles.busyLabel}>
		<Spinner size={13} />
		{text}
	</span>
);

interface PathWellProps {
	path: string;
	home: string | null;
	bad?: boolean;
	change?: {
		onClick: () => void;
		disabled: boolean;
		autoFocus: boolean;
	};
}

const PathWell = ({ path, home, bad = false, change }: PathWellProps) => (
	<div className={clsx(styles.well, bad && styles.wellBad)}>
		<FolderGlyph />
		<span className={styles.pathText}>{abbreviateHomePath(path, home)}</span>
		{change && (
			<Button
				variant="subtle"
				size="sm"
				className={styles.wellChange}
				disabled={change.disabled}
				data-autofocus={change.autoFocus ? "true" : undefined}
				onClick={change.onClick}
			>
				Change…
			</Button>
		)}
	</div>
);

const ErrLine = ({ text }: { text: string }) => (
	<div className={styles.err}>
		<WarnGlyph />
		<span>{text}</span>
	</div>
);

const BackButton = ({
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

interface FoundViewProps {
	path: string;
	source: DetectionSource;
	home: string | null;
	busy: boolean;
	disabled: boolean;
	onUse: () => void;
	onPickDifferent: () => void;
	onStartNew: () => void;
}

const FoundView = ({
	path,
	source,
	home,
	busy,
	disabled,
	onUse,
	onPickDifferent,
	onStartNew,
}: FoundViewProps) => {
	const inert = busy || disabled;
	return (
		<>
			<div className={styles.mark} aria-hidden="true">
				<ShelfMark />
			</div>
			<h1 className={styles.title}>Found your Calibre library</h1>
			<PathWell path={path} home={home} />
			<p className={styles.src}>
				{source === "calibre-config"
					? "Via your Calibre settings."
					: "At Calibre’s default location."}
			</p>
			<div className={styles.actions}>
				<Button
					variant="primary"
					fullWidth
					disabled={inert}
					data-autofocus="true"
					onClick={onUse}
				>
					{busy ? <BusyLabel text="Opening…" /> : "Use This Library"}
				</Button>
				<div className={styles.escapes}>
					<Button
						variant="subtle"
						size="sm"
						className={styles.escapeBtn}
						disabled={inert}
						onClick={onPickDifferent}
					>
						Choose a Different Folder…
					</Button>
					<Button
						variant="subtle"
						size="sm"
						className={styles.escapeBtn}
						disabled={inert}
						onClick={onStartNew}
					>
						Start a New Library…
					</Button>
				</div>
			</div>
		</>
	);
};

interface ChooserViewProps {
	disabled: boolean;
	onAdopt: () => void;
	onStartNew: () => void;
}

const ChooserView = ({ disabled, onAdopt, onStartNew }: ChooserViewProps) => (
	<>
		<div className={styles.mark} aria-hidden="true">
			<ShelfMark />
		</div>
		<h1 className={styles.title}>Set up your library</h1>
		<p className={styles.lede}>
			Citadel keeps your books in a Calibre-compatible library.
		</p>
		<div className={styles.choices}>
			<button
				type="button"
				className={styles.choice}
				disabled={disabled}
				data-autofocus="true"
				onClick={onAdopt}
			>
				<span className={styles.choiceIcon}>
					<FolderGlyph />
				</span>
				<span>
					<span className={styles.choiceTitle}>I have a Calibre library</span>
					<br />
					<span className={styles.choiceDesc}>
						Open your existing library folder.
					</span>
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
					<span className={styles.choiceDesc}>
						Create an empty library at ~/Citadel.
					</span>
				</span>
				<span className={styles.choiceChevron}>
					<ChevronRight />
				</span>
			</button>
		</div>
	</>
);

const ValidatingView = ({
	path,
	home,
	onBack,
}: {
	path: string;
	home: string | null;
	onBack: () => void;
}) => (
	<>
		<BackButton onClick={onBack} autoFocus />
		<h1 className={styles.title}>Open your Calibre library</h1>
		<PathWell path={path} home={home} />
		<p className={clsx(styles.src, styles.srcChecking)}>
			<Spinner size={12} /> Checking folder…
		</p>
	</>
);

interface InvalidViewProps {
	path: string;
	home: string | null;
	onPickDifferent: () => void;
	onCreateHere: () => void;
	onBack: () => void;
}

const InvalidView = ({
	path,
	home,
	onPickDifferent,
	onCreateHere,
	onBack,
}: InvalidViewProps) => (
	<>
		<BackButton onClick={onBack} />
		<h1 className={styles.title}>That folder isn’t a library</h1>
		<PathWell path={path} home={home} bad />
		<ErrLine text={ADOPT_INVALID_ERROR} />
		<div className={styles.actions}>
			<Button
				variant="primary"
				fullWidth
				data-autofocus="true"
				onClick={onPickDifferent}
			>
				Choose a Different Folder…
			</Button>
			<div className={styles.crossover}>
				<Button
					variant="subtle"
					size="sm"
					className={styles.escapeBtn}
					onClick={onCreateHere}
				>
					Start a New Library Here
				</Button>
			</div>
		</div>
	</>
);

interface CreateViewProps {
	path: string | null;
	isDefault: boolean;
	error: CreateError | null;
	busy: boolean;
	/** The native change-target sheet is up: freeze the card beneath it. */
	frozen: boolean;
	openInsteadBusy: boolean;
	home: string | null;
	onBack: () => void;
	onChangeTarget: () => void;
	onCommit: () => void;
	onOpenInstead: () => void;
}

const CreateView = ({
	path,
	isDefault,
	error,
	busy,
	frozen,
	openInsteadBusy,
	home,
	onBack,
	onChangeTarget,
	onCommit,
	onOpenInstead,
}: CreateViewProps) => {
	const inert = busy || frozen || openInsteadBusy;
	return (
		<>
			<BackButton onClick={onBack} disabled={inert} />
			<h1 className={styles.title}>New library</h1>
			<PathWell
				path={path ?? ""}
				home={home}
				bad={error !== null}
				change={{
					onClick: onChangeTarget,
					disabled: inert,
					autoFocus: error?.code === "folder-not-empty",
				}}
			/>
			{error !== null && <ErrLine text={error.message} />}
			{error === null && (
				<p className={styles.helper}>
					{isDefault
						? "Citadel creates this folder. Books you import are copied into it."
						: "Books you import are copied into this folder."}
				</p>
			)}
			<div className={styles.actions}>
				<Button
					variant="primary"
					fullWidth
					disabled={error !== null || inert || path === null}
					data-autofocus={error === null ? "true" : undefined}
					onClick={onCommit}
				>
					{busy ? <BusyLabel text="Creating…" /> : "Create Library"}
				</Button>
				{error?.code === "already-a-library" && (
					<div className={styles.crossover}>
						<Button
							variant="subtle"
							size="sm"
							className={styles.escapeBtn}
							disabled={openInsteadBusy || frozen}
							data-autofocus="true"
							onClick={onOpenInstead}
						>
							{openInsteadBusy ? (
								<BusyLabel text="Opening…" />
							) : (
								"Open It Instead"
							)}
						</Button>
					</div>
				)}
			</div>
		</>
	);
};

interface CloudWarnViewProps {
	path: string;
	provider: string;
	home: string | null;
	onCancel: () => void;
	onContinue: () => void;
}

const CloudWarnView = ({
	path,
	provider,
	home,
	onCancel,
	onContinue,
}: CloudWarnViewProps) => (
	<>
		<div className={styles.mark} aria-hidden="true">
			<CloudMark />
		</div>
		<h1 className={styles.title}>This folder is synced</h1>
		<PathWell path={path} home={home} />
		<p className={styles.lede} style={{ marginTop: 10 }}>
			{provider} syncs this folder, and a sync while the library is open can
			conflict with its database.
		</p>
		<div className={styles.rowActions}>
			<Button variant="default" onClick={onCancel}>
				Cancel
			</Button>
			<Button variant="primary" data-autofocus="true" onClick={onContinue}>
				Continue
			</Button>
		</div>
	</>
);

const STAGE_LABELS = [
	"Opening library",
	"Loading metadata",
	"Preparing covers",
] as const;

const OpeningView = ({
	stage,
	announce,
}: {
	stage: 0 | 1 | 2;
	announce: (text: string) => void;
}) => {
	useEffect(() => {
		announce(`${STAGE_LABELS[stage]}…`);
	}, [stage, announce]);

	return (
		<>
			<h1 className={clsx(styles.title, styles.titleSm)}>
				Opening your library
			</h1>
			<ol className={styles.stages}>
				{STAGE_LABELS.map((label, index) => (
					<li
						key={label}
						className={clsx(
							styles.stageRow,
							index === stage && styles.stageActive,
						)}
						aria-current={index === stage ? "step" : undefined}
					>
						<span className={styles.stageGlyph}>
							{index < stage ? (
								<CheckGlyph />
							) : index === stage ? (
								<Spinner size={13} />
							) : (
								<span className={styles.stageDot} />
							)}
						</span>
						{label}
					</li>
				))}
			</ol>
		</>
	);
};

interface RevealViewProps {
	books: number;
	authors: number;
	reduced: boolean;
	announce: (text: string) => void;
	onContinue: () => void;
}

/** Count-up per the prototype: ease-out cubic, books then authors, and the
 * settled counts announced once. Deliberately never auto-continues — the
 * moment is user-paced, and Return advances via the focused default. */
const RevealView = ({
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

interface BrokenViewProps {
	path: string;
	retry: "idle" | "checking" | "failed";
	disabled: boolean;
	home: string | null;
	onRetry: () => void;
	onPickDifferent: () => void;
	onStartNew: () => void;
}

const BrokenView = ({
	path,
	retry,
	disabled,
	home,
	onRetry,
	onPickDifferent,
	onStartNew,
}: BrokenViewProps) => {
	const retryRef = useRef<HTMLButtonElement>(null);
	const inert = retry === "checking" || disabled;

	// After a failed retry the button re-arms; put focus back on it so Return
	// retries again (the prototype's recovery arc).
	useEffect(() => {
		if (retry === "failed") {
			retryRef.current?.focus({ preventScroll: true });
		}
	}, [retry]);

	return (
		<>
			<h1 className={styles.title}>Your library isn’t reachable</h1>
			<PathWell path={path} home={home} bad />
			<p className={styles.helper}>
				Citadel couldn’t open the library at this path. If it lives on an
				external drive or a network share, reconnect it, then retry.
			</p>
			<div className={styles.actions}>
				<Button
					ref={retryRef}
					variant="primary"
					fullWidth
					disabled={inert}
					data-autofocus="true"
					onClick={onRetry}
				>
					{retry === "checking" ? <BusyLabel text="Checking…" /> : "Retry"}
				</Button>
			</div>
			{retry === "failed" && (
				<div className={styles.retryNote}>Still not reachable.</div>
			)}
			<div className={styles.divider} />
			<div className={clsx(styles.escapes, styles.escapesAfterDivider)}>
				<Button
					variant="subtle"
					size="sm"
					className={styles.escapeBtn}
					disabled={inert}
					onClick={onPickDifferent}
				>
					Open a Different Library…
				</Button>
				<Button
					variant="subtle"
					size="sm"
					className={styles.escapeBtn}
					disabled={inert}
					onClick={onStartNew}
				>
					Start a New Library…
				</Button>
			</div>
		</>
	);
};

/* --------------------------- state → view map --------------------------- */

interface ResolvedView {
	key: string;
	label: string;
	hasBack: boolean;
	node: ReactNode;
}

const resolveView = (
	snapshot: FlowSnapshot,
	send: FirstRunFlow["send"],
	home: string | null,
	announce: (text: string) => void,
	reduced: boolean,
): ResolvedView | null => {
	const { step, detection, brokenPath } = snapshot;

	const foundView = (busy: boolean, disabled: boolean): ResolvedView | null =>
		detection && {
			key: "found",
			label: "Found your Calibre library",
			hasBack: false,
			node: (
				<FoundView
					path={detection.path}
					source={detection.source}
					home={home}
					busy={busy}
					disabled={disabled}
					onUse={() => send({ type: "USE_FOUND" })}
					onPickDifferent={() => send({ type: "CHOOSE_ADOPT" })}
					onStartNew={() => send({ type: "CHOOSE_CREATE" })}
				/>
			),
		};

	const chooserView = (disabled: boolean): ResolvedView => ({
		key: "chooser",
		label: "Set up your library",
		hasBack: false,
		node: (
			<ChooserView
				disabled={disabled}
				onAdopt={() => send({ type: "CHOOSE_ADOPT" })}
				onStartNew={() => send({ type: "CHOOSE_CREATE" })}
			/>
		),
	});

	const brokenView = (
		retry: "idle" | "checking" | "failed",
		disabled: boolean,
	): ResolvedView => ({
		key: "broken",
		label: "Your library isn’t reachable",
		hasBack: false,
		node: (
			<BrokenView
				path={brokenPath ?? ""}
				retry={retry}
				disabled={disabled}
				home={home}
				onRetry={() => send({ type: "RETRY" })}
				onPickDifferent={() => send({ type: "CHOOSE_ADOPT" })}
				onStartNew={() => send({ type: "CHOOSE_CREATE" })}
			/>
		),
	});

	/** The card as it looks while the native sheet floats over it. */
	const frozenRoot = (root: FlowRoot): ResolvedView | null => {
		switch (root) {
			case "found":
				return foundView(false, true);
			case "chooser":
				return chooserView(true);
			case "broken":
				return brokenView("idle", true);
		}
	};

	const createView = (props: {
		path: string | null;
		defaultPath: string | null;
		error: CreateError | null;
		busy: boolean;
		frozen: boolean;
		openInsteadBusy: boolean;
	}): ResolvedView => ({
		key: `create:${props.error?.code ?? "ok"}`,
		label: "New library",
		hasBack: true,
		node: (
			<CreateView
				path={props.path}
				isDefault={props.path !== null && props.path === props.defaultPath}
				error={props.error}
				busy={props.busy}
				frozen={props.frozen}
				openInsteadBusy={props.openInsteadBusy}
				home={home}
				onBack={() => send({ type: "BACK" })}
				onChangeTarget={() => send({ type: "CHANGE_CREATE_TARGET" })}
				onCommit={() => send({ type: "COMMIT_CREATE" })}
				onOpenInstead={() => send({ type: "OPEN_INSTEAD" })}
			/>
		),
	});

	/** Create card frozen mid-adopt of an existing library (Open It Instead). */
	const openInsteadView = (path: string): ResolvedView =>
		createView({
			path,
			defaultPath: null,
			error: { code: "already-a-library", message: CREATE_EXISTING_ERROR },
			busy: false,
			frozen: false,
			openInsteadBusy: true,
		});

	switch (step.id) {
		case "detecting":
			return null;

		case "found":
			return foundView(false, false);

		case "chooser":
			return chooserView(false);

		case "picking":
			return frozenRoot(step.root);

		case "validating":
			if (!step.slow) return frozenRoot(step.root);
			return {
				key: "validating",
				label: "Checking folder",
				hasBack: true,
				node: (
					<ValidatingView
						path={step.path}
						home={home}
						onBack={() => send({ type: "BACK" })}
					/>
				),
			};

		case "adopt-invalid":
			return {
				key: "adopt-invalid",
				label: "That folder isn’t a library",
				hasBack: true,
				node: (
					<InvalidView
						path={step.path}
						home={home}
						onPickDifferent={() => send({ type: "CHOOSE_ADOPT" })}
						onCreateHere={() => send({ type: "CROSS_CREATE_HERE" })}
						onBack={() => send({ type: "BACK" })}
					/>
				),
			};

		case "create":
			return createView({
				path: step.path,
				defaultPath: step.defaultPath,
				error: step.error,
				busy: step.busy,
				frozen: step.picking,
				openInsteadBusy: false,
			});

		case "sync-check": {
			const { commit } = step;
			switch (commit.kind) {
				case "adopt-found":
					return foundView(true, false);
				case "adopt-picked":
					return frozenRoot(step.root);
				case "adopt-open-instead":
					return openInsteadView(step.path);
				case "create":
					return createView({
						path: commit.create.path,
						defaultPath: commit.create.defaultPath,
						error: null,
						busy: true,
						frozen: false,
						openInsteadBusy: false,
					});
				default:
					return null;
			}
		}

		case "cloud-warn":
			return {
				key: "cloud",
				label: "This folder is synced",
				hasBack: false,
				node: (
					<CloudWarnView
						path={step.path}
						provider={step.provider}
						home={home}
						onCancel={() => send({ type: "CLOUD_CANCEL" })}
						onContinue={() => send({ type: "CLOUD_CONTINUE" })}
					/>
				),
			};

		case "opening": {
			if (step.phase === "staged") {
				return {
					key: "opening",
					label: "Opening your library",
					hasBack: false,
					node: <OpeningView stage={step.stage} announce={announce} />,
				};
			}
			switch (step.via) {
				case "found":
					return foundView(true, false);
				case "picker":
					return frozenRoot(step.root);
				case "open-instead":
					return openInsteadView(step.path);
				case "retry":
					return brokenView("checking", false);
				default:
					return null;
			}
		}

		case "reveal":
			return {
				key: "reveal",
				label: "Your library is ready",
				hasBack: false,
				node: (
					<RevealView
						books={step.books}
						authors={step.authors}
						reduced={reduced}
						announce={announce}
						onContinue={() => send({ type: "SHOW_BOOKS" })}
					/>
				),
			};

		case "broken":
			return brokenView(step.retry, false);

		case "done":
			return null;
	}
};

/* ------------------------------ morph card ------------------------------ */

interface MorphCardProps {
	viewKey: string;
	label: string;
	hasBack: boolean;
	children: ReactNode;
}

/**
 * The one morphing card: cross-fades views (old fades out in place, new
 * slides up 6px) while the card height tweens to fit. A new morph cancels the
 * previous one — views never stack. Every morph moves focus to the incoming
 * view's `[data-autofocus]` control, or to the view container when nothing is
 * actionable, so focus never silently drops to `<body>`.
 */
interface GhostView {
	html: string;
	hasBack: boolean;
	fading: boolean;
}

const MorphCard = ({ viewKey, label, hasBack, children }: MorphCardProps) => {
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: prevKey re-runs the focus move for each incoming view
	useLayoutEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const target = view.querySelector<HTMLElement>(
			"[data-autofocus]:not(:disabled)",
		);
		(target ?? view).focus({ preventScroll: true });
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

/* ------------------------------- overlay -------------------------------- */

interface FirstRunOverlayProps {
	snapshot: FlowSnapshot;
	send: FirstRunFlow["send"];
	onFinished: () => void;
}

const FirstRunOverlay = ({
	snapshot,
	send,
	onFinished,
}: FirstRunOverlayProps) => {
	const home = useHomeDir();
	const reduced = usePrefersReducedMotion();
	const [announced, setAnnounced] = useState("");
	const announce = useCallback((text: string) => setAnnounced(text), []);

	const done = snapshot.step.id === "done";
	const lastViewRef = useRef<ResolvedView | null>(null);
	const resolved = done
		? lastViewRef.current
		: resolveView(snapshot, send, home, announce, reduced);
	if (!done) {
		lastViewRef.current = resolved;
	}

	// Escape backs out of steerable sub-screens; the machine keeps it inert at
	// the roots, during opening, and on the reveal.
	useEffect(() => {
		if (done) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			send({ type: "ESCAPE" });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [done, send]);

	// Announce each state change via the card's accessible name.
	const label = resolved?.label;
	useEffect(() => {
		if (label) setAnnounced(label);
	}, [label]);

	// Handoff: the card dissolves, the app beneath takes over, then unmount.
	useEffect(() => {
		if (!done) return;
		const timer = setTimeout(onFinished, reduced ? 0 : HANDOFF_MS);
		return () => clearTimeout(timer);
	}, [done, reduced, onFinished]);

	return (
		<div className={clsx(styles.layer, done && styles.layerHandoff)}>
			{resolved && (
				<MorphCard
					viewKey={resolved.key}
					label={resolved.label}
					hasBack={resolved.hasBack}
				>
					{resolved.node}
				</MorphCard>
			)}
			<span className={styles.sr} role="status" aria-live="polite">
				{announced}
			</span>
		</div>
	);
};

/* -------------------------------- gate ---------------------------------- */

interface FirstRunExperienceProps {
	mode: FlowMode;
	children: ReactNode;
}

/** Runs the flow over the (initially unmounted) app. The app mounts beneath
 * the opaque setup layer once the flow commits to a library, so its open
 * sequence drives the card's staged progress; on handoff the overlay
 * dissolves away and never remounts. */
const FirstRunExperience = ({ mode, children }: FirstRunExperienceProps) => {
	const { snapshot, send } = useFirstRunFlow(mode);
	const [finished, setFinished] = useState(false);
	const onFinished = useCallback(() => setFinished(true), []);

	return (
		<>
			{(snapshot.committed || finished) && children}
			{!finished && (
				<FirstRunOverlay
					snapshot={snapshot}
					send={send}
					onFinished={onFinished}
				/>
			)}
		</>
	);
};

/**
 * Boot decision (BUILD-SPEC step 1): no active library → first-run flow; an
 * active library that fails validation → broken-path flow; otherwise the app
 * renders untouched. Must only mount after settings hydration.
 */
export const FirstRunGate = ({ children }: { children: ReactNode }) => {
	const decision = useBootDecision();

	switch (decision.kind) {
		case "checking":
			return null;
		case "normal":
			return <>{children}</>;
		case "first-run":
			return (
				<FirstRunExperience mode={{ kind: "first-run" }}>
					{children}
				</FirstRunExperience>
			);
		case "broken-path":
			return (
				<FirstRunExperience mode={{ kind: "broken-path", path: decision.path }}>
					{children}
				</FirstRunExperience>
			);
	}
};
