import clsx from "clsx";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DetectionSource } from "@/bindings";
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
} from "@/lib/first-run/machine";
import type { FirstRunFlow } from "@/lib/hooks/use-first-run-flow";
import {
	useBootDecision,
	useFirstRunFlow,
} from "@/lib/hooks/use-first-run-flow";
import { abbreviateHomePath, useHomeDir } from "@/lib/hooks/use-home-dir";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import styles from "./FirstRunFlow.module.css";
import {
	BackButton,
	BusyLabel,
	ChooserView,
	ErrLine,
	FolderGlyph,
	MorphCard,
	RevealView,
	ShelfMark,
} from "./SetupCard";

/*
 * CDL-19 first-run onboarding: one card on the window background, morphing
 * between states. Visual contract: ai-docs/design/cdl-19-first-run/
 * morphing-card-improved.html (layout, copy, and motion transcribed
 * verbatim). Every component here is a pure renderer of (state, callbacks);
 * behavior lives in the flow machine and its hook.
 */

const HANDOFF_MS = 420;

/* ------------------------------- icons -------------------------------- */

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

/* --------------------------- shared fragments --------------------------- */

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
						className={styles.escapeBtn}
						disabled={inert}
						onClick={onPickDifferent}
					>
						Choose a Different Folder…
					</Button>
					<Button
						variant="subtle"
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
	busy: boolean;
	onCancel: () => void;
	onContinue: () => void;
}

const CloudWarnView = ({
	path,
	provider,
	home,
	busy,
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
			<Button variant="default" disabled={busy} onClick={onCancel}>
				Cancel
			</Button>
			<Button
				variant="primary"
				data-autofocus="true"
				disabled={busy}
				onClick={onContinue}
			>
				{busy ? <BusyLabel text="Opening…" /> : "Continue"}
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
					className={styles.escapeBtn}
					disabled={inert}
					onClick={onPickDifferent}
				>
					Open a Different Library…
				</Button>
				<Button
					variant="subtle"
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
						busy={false}
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
				case "cloud-warn":
					// Same view key as the interactive warning: the card holds
					// still and only Continue morphs into the spinner.
					return {
						key: "cloud",
						label: "This folder is synced",
						hasBack: false,
						node: (
							<CloudWarnView
								path={step.path}
								provider={step.provider ?? "A cloud service"}
								home={home}
								busy={true}
								onCancel={() => {}}
								onContinue={() => {}}
							/>
						),
					};
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
				<FirstRunExperience key={decision.run} mode={{ kind: "first-run" }}>
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
