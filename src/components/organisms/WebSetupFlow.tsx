import clsx from "clsx";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Button, Checkbox, Spinner, TextInput } from "@/components/ui";
import type { CopyText } from "@/lib/hooks/use-copy-text";
import { useCopyText } from "@/lib/hooks/use-copy-text";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type { WebSetupFlow as WebSetupFlowState } from "@/lib/hooks/use-web-setup-flow";
import { useWebSetupFlow } from "@/lib/hooks/use-web-setup-flow";
import type {
	FolderBrowser,
	PathVerdict,
	PublicUrls,
	SetupMode,
	SetupSnapshot,
} from "@/lib/web-setup/machine";
import {
	isLocalAddress,
	mustBeReadOnly,
	READ_ONLY_DESCRIPTION,
	READ_ONLY_PROMPT,
	UPGRADE_PROMPT,
	verdict,
} from "@/lib/web-setup/machine";
import type {
	FoundLibraries,
	ServedLibrary,
} from "@/lib/services/library-catalog/types";
import card from "./FirstRunFlow.module.css";
import {
	BackButton,
	BookGlyph,
	BusyLabel,
	ChevronRight,
	ChooserView,
	ErrLine,
	FolderGlyph,
	fmt,
	GlobeGlyph,
	MorphCard,
	plural,
	RevealView,
} from "./SetupCard";
import styles from "./WebSetupFlow.module.css";

/*
 * CDL-39 web setup: the administrator chooses the library a server serves,
 * on the same morphing card as the desktop's first run. Pure renderers of
 * (state, callbacks); the machine and its hook own behaviour.
 */

const HANDOFF_MS = 420;

const UpGlyph = () => (
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
		<path d="M3.5 10 8 5.5l4.5 4.5" />
	</svg>
);

/* ------------------------------ card views ------------------------------ */

interface AddressViewProps {
	urls: PublicUrls;
	typed: string;
	checking: boolean;
	stillMissing: boolean;
	error: string | null;
	copied: boolean;
	onType: (url: string) => void;
	onCopy: (text: string) => void;
	onCheck: () => void;
	onDone: () => void;
}

const CopyGlyph = () => (
	<svg
		width="13"
		height="13"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.4"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
		<path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1.5" />
	</svg>
);

/** The server's public URLs, or the line that sets one, before the library. */
const AddressView = ({
	urls,
	typed,
	checking,
	stillMissing,
	error,
	copied,
	onType,
	onCopy,
	onCheck,
	onDone,
}: AddressViewProps) => {
	const configured = urls.listed.length > 0;
	if (configured) {
		return (
			<>
				<h1 className={card.title}>Public URLs</h1>
				<p className={card.lede}>
					Citadel only accepts traffic at these URLs: you can add more to your
					configuration.
				</p>
				<ul className={styles.urlList}>
					{urls.listed.map((url) => (
						<li key={url}>
							<GlobeGlyph />
							<span className={styles.urlListText} data-selectable>
								{url}
							</span>
							{url === urls.current && (
								<span className={styles.currentPill}>Current</span>
							)}
						</li>
					))}
				</ul>
				<div className={card.actions}>
					<Button
						variant="primary"
						fullWidth
						data-autofocus="true"
						onClick={onDone}
					>
						Continue
					</Button>
				</div>
			</>
		);
	}
	const local = urls.current === null || isLocalAddress(urls.current);
	const current = urls.current ?? "";
	return (
		<>
			<h1 className={card.title}>Public URL</h1>
			<div className={styles.addressCopy}>
				<p>
					Optional: to have Citadel accept traffic only at this URL and
					localhost, add it to <code>CITADEL_PUBLIC_URLS</code> (or{" "}
					<code>publicUrls</code> in the config file) and restart Citadel.
				</p>
			</div>
			{local ? (
				<div className={styles.typedAddress}>
					<TextInput
						label="URL others will use"
						name="publicUrl"
						type="url"
						inputMode="url"
						autoCapitalize="none"
						spellCheck={false}
						value={typed}
						onChange={(event) => onType(event.currentTarget.value)}
					/>
				</div>
			) : (
				<div className={styles.currentUrl}>
					<span className={styles.currentUrlLabel}>Current URL</span>
					<div className={styles.currentUrlRow}>
						<code className={styles.currentUrlValue} data-selectable>
							{current}
						</code>
						<Button
							variant="subtle"
							className={styles.copyButton}
							aria-label={copied ? "Copied" : "Copy URL"}
							onClick={() => onCopy(current)}
						>
							{copied ? "Copied" : <CopyGlyph />}
						</Button>
					</div>
				</div>
			)}
			{stillMissing && (
				<ErrLine text="Citadel still has no public URLs. Restart it after setting CITADEL_PUBLIC_URLS, then continue." />
			)}
			{error && <ErrLine text={error} />}
			<div className={styles.pairActions}>
				<Button disabled={checking} onClick={onDone}>
					Skip
				</Button>
				<Button
					variant="primary"
					disabled={checking}
					data-autofocus={local ? undefined : "true"}
					onClick={onCheck}
				>
					{checking ? <BusyLabel text="Checking…" /> : "Continue"}
				</Button>
			</div>
		</>
	);
};

const LoadingView = () => (
	<>
		<h1 className={clsx(card.title, card.titleSm)}>Checking the server</h1>
		<p className={clsx(card.src, card.srcChecking)}>
			<Spinner size={12} /> One moment…
		</p>
	</>
);

const UnavailableView = ({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) => (
	<>
		<h1 className={card.title}>Couldn’t reach the server</h1>
		<ErrLine text={message} />
		<div className={card.actions}>
			<Button
				variant="primary"
				fullWidth
				data-autofocus="true"
				onClick={onRetry}
			>
				Try Again
			</Button>
		</div>
	</>
);

interface BrowserPanelProps {
	browser: FolderBrowser;
	onBrowseTo: (path: string | null) => void;
	onPick: (path: string) => void;
	onClose: () => void;
}

const BrowserPanel = ({
	browser,
	onBrowseTo,
	onPick,
	onClose,
}: BrowserPanelProps) => {
	const { listing } = browser;
	return (
		<section className={styles.browser} aria-label="Folders on the server">
			<div className={styles.browserHead}>
				<Button
					variant="default"
					disabled={browser.loading || !listing?.parent}
					aria-label="Up one folder"
					onClick={() => onBrowseTo(listing?.parent ?? null)}
				>
					<UpGlyph />
				</Button>
				<span
					className={styles.browserPath}
					title={browser.path}
					data-selectable
				>
					{browser.path}
				</span>
			</div>
			{browser.loading ? (
				<div className={styles.browserBusy}>
					<Spinner size={12} /> Listing…
				</div>
			) : browser.error ? (
				<ErrLine text={browser.error} />
			) : listing && listing.entries.length > 0 ? (
				<ul className={styles.entries}>
					{listing.entries.map((entry) => (
						<li key={entry.path}>
							<button
								type="button"
								className={styles.entry}
								onClick={() =>
									entry.isLibrary ? onPick(entry.path) : onBrowseTo(entry.path)
								}
							>
								<FolderGlyph />
								<span className={styles.entryName}>{entry.name}</span>
								{entry.isLibrary && (
									<span className={styles.entryTag}>Library</span>
								)}
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className={styles.browserEmpty}>
					<FolderGlyph />
					This folder has no folders inside it.
				</div>
			)}
			<div className={styles.browserFoot}>
				<Button variant="default" onClick={onClose}>
					Cancel
				</Button>
				<Button
					variant="default"
					disabled={browser.loading || !listing}
					onClick={() => listing && onPick(listing.path)}
				>
					Choose This Folder
				</Button>
			</div>
		</section>
	);
};

interface PathViewProps {
	mode: SetupMode;
	path: string;
	verdict: PathVerdict;
	inspectionLibrary: {
		bookCount: number;
		authorCount: number;
		schemaVersion: number;
		upgradeAvailable: boolean;
	} | null;
	inspectionStatus: string | null;
	busy: boolean;
	error: string | null;
	browser: FolderBrowser | null;
	onPathChange: (path: string) => void;
	onContinue: () => void;
	onSwitchMode: () => void;
	onOpenBrowser: () => void;
	onBrowseTo: (path: string | null) => void;
	onPick: (path: string) => void;
	onCloseBrowser: () => void;
	onBack: () => void;
}

const PathView = ({
	mode,
	path,
	verdict: result,
	inspectionLibrary,
	inspectionStatus,
	busy,
	error,
	browser,
	onPathChange,
	onContinue,
	onSwitchMode,
	onOpenBrowser,
	onBrowseTo,
	onPick,
	onCloseBrowser,
	onBack,
}: PathViewProps) => {
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onContinue();
	};
	const inert = busy || browser !== null;
	return (
		<form onSubmit={submit}>
			<BackButton onClick={onBack} disabled={busy} />
			<h1 className={card.title}>
				{mode === "create" ? "New library" : "Use an existing library"}
			</h1>
			<p className={card.lede}>
				{mode === "create"
					? "Choose an empty folder on the server for it."
					: "Choose the server folder that holds metadata.db."}
			</p>
			<div className={styles.field}>
				<div className={styles.fieldInput}>
					<TextInput
						label="Folder on the server"
						name="path"
						placeholder={browser ? browser.path : "/srv/books"}
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						value={path}
						disabled={inert}
						data-autofocus="true"
						onChange={(event) => onPathChange(event.currentTarget.value)}
					/>
				</div>
				{!browser && (
					<Button variant="default" disabled={busy} onClick={onOpenBrowser}>
						Browse…
					</Button>
				)}
			</div>
			{browser && (
				<BrowserPanel
					browser={browser}
					onBrowseTo={onBrowseTo}
					onPick={onPick}
					onClose={onCloseBrowser}
				/>
			)}
			{error !== null && <ErrLine text={error} />}
			{error === null && result.kind === "checking" && (
				<p className={clsx(card.src, card.srcChecking)}>
					<Spinner size={12} /> Checking folder…
				</p>
			)}
			{error === null && result.kind === "error" && (
				<ErrLine text={result.message} />
			)}
			{error === null && result.kind === "crossover" && (
				<ErrLine text={result.message} />
			)}
			{error === null && result.kind === "ok" && mode === "adopt" && (
				<p className={styles.okLine}>
					<FolderGlyph />
					<span>
						<strong>
							{fmt(inspectionLibrary?.bookCount ?? 0)}{" "}
							{plural(inspectionLibrary?.bookCount ?? 0, "book")}
						</strong>{" "}
						by {fmt(inspectionLibrary?.authorCount ?? 0)}{" "}
						{plural(inspectionLibrary?.authorCount ?? 0, "author")}
						{inspectionLibrary?.upgradeAvailable
							? ", in an older Calibre format"
							: ""}
						.
					</span>
				</p>
			)}
			{error === null && result.kind === "ok" && mode === "create" && (
				<p className={card.helper}>
					{inspectionStatus === "missing"
						? "Citadel creates this folder. Books you add are copied into it."
						: "Books you add are copied into this folder."}
				</p>
			)}
			<div className={card.actions}>
				<Button
					type="submit"
					variant="primary"
					fullWidth
					disabled={inert || result.kind === "error" || path.trim() === ""}
				>
					{busy ? <BusyLabel text="Checking…" /> : "Continue"}
				</Button>
				{result.kind === "crossover" && (
					<div className={card.crossover}>
						<Button
							variant="subtle"
							className={card.escapeBtn}
							disabled={inert}
							onClick={onSwitchMode}
						>
							{mode === "create"
								? "Use It Instead"
								: "Start a New Library Here"}
						</Button>
					</div>
				)}
			</div>
		</form>
	);
};

interface FoundChoicesProps {
	found: FoundLibraries;
	onUse: (path: string) => void;
	onCreateIn: (path: string) => void;
}

/** What the server found in the folders mounted for libraries. */
const FoundChoices = ({ found, onUse, onCreateIn }: FoundChoicesProps) => (
	<>
		{found.libraries.map((library, index) => {
			const books = library.library?.bookCount ?? 0;
			const details = [
				`${fmt(books)} ${plural(books, "book")}`,
				library.path,
				library.library?.writable === false ? "read-only" : null,
			].filter(Boolean);
			return (
				<button
					key={library.path}
					type="button"
					className={card.choice}
					data-autofocus={index === 0 ? "true" : undefined}
					onClick={() => onUse(library.path)}
				>
					<span className={card.choiceIcon}>
						<BookGlyph />
					</span>
					<span className={styles.choiceText}>
						<span className={card.choiceTitle}>{library.name}</span>
						<br />
						<span className={card.choiceDesc}>{details.join(" · ")}</span>
					</span>
					<span className={card.choiceChevron}>
						<ChevronRight />
					</span>
				</button>
			);
		})}
		{found.createIn.map((spot, index) => (
			<button
				key={spot.path}
				type="button"
				className={card.choice}
				data-autofocus={
					found.libraries.length === 0 && index === 0 ? "true" : undefined
				}
				onClick={() => onCreateIn(spot.path)}
			>
				<span className={card.choiceIcon}>
					<FolderGlyph />
				</span>
				<span className={styles.choiceText}>
					<span className={card.choiceTitle}>
						Start a new library in {spot.path}
					</span>
					<br />
					<span className={card.choiceDesc}>This folder is empty.</span>
				</span>
				<span className={card.choiceChevron}>
					<ChevronRight />
				</span>
			</button>
		))}
	</>
);

interface ConfirmViewProps {
	mode: SetupMode;
	path: string;
	name: string;
	upgradeAvailable: boolean;
	upgrade: boolean;
	readOnly: boolean;
	/** The server can't write this library; `readOnlyReason` says why. */
	readOnlyForced: boolean;
	readOnlyReason: string | null;
	busy: boolean;
	error: string | null;
	onNameChange: (name: string) => void;
	onUpgradeChange: (upgrade: boolean) => void;
	onReadOnlyChange: (readOnly: boolean) => void;
	onCommit: () => void;
	onBack: () => void;
}

const ConfirmView = ({
	mode,
	path,
	name,
	upgradeAvailable,
	upgrade,
	readOnly,
	readOnlyForced,
	readOnlyReason,
	busy,
	error,
	onNameChange,
	onUpgradeChange,
	onReadOnlyChange,
	onCommit,
	onBack,
}: ConfirmViewProps) => {
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onCommit();
	};
	return (
		<form onSubmit={submit}>
			<BackButton onClick={onBack} disabled={busy} />
			<h1 className={card.title}>
				{mode === "create" ? "Name your library" : "Open this library"}
			</h1>
			<div className={styles.pathLine}>
				<FolderGlyph />
				<span data-selectable>{path}</span>
			</div>
			<div className={styles.field}>
				<TextInput
					label="Library name"
					name="name"
					autoComplete="off"
					value={name}
					disabled={busy}
					data-autofocus="true"
					onChange={(event) => onNameChange(event.currentTarget.value)}
				/>
			</div>
			{mode === "adopt" && (
				<div className={styles.option}>
					<Checkbox
						checked={readOnly}
						disabled={busy || readOnlyForced}
						label={READ_ONLY_PROMPT}
						onCheckedChange={onReadOnlyChange}
					/>
					<p className={styles.optionNote}>
						{readOnlyForced && readOnlyReason
							? readOnlyReason
							: READ_ONLY_DESCRIPTION}
					</p>
				</div>
			)}
			{mode === "adopt" && upgradeAvailable && !readOnly && (
				<div className={styles.upgrade}>
					<Checkbox
						checked={upgrade}
						disabled={busy}
						label={UPGRADE_PROMPT}
						onCheckedChange={onUpgradeChange}
					/>
				</div>
			)}
			{mode === "create" && (
				<p className={card.helper}>
					Readers you add see this name. You can change it later.
				</p>
			)}
			{error !== null && <ErrLine text={error} />}
			<div className={card.actions}>
				<Button type="submit" variant="primary" fullWidth disabled={busy}>
					{busy ? (
						<BusyLabel text={mode === "create" ? "Creating…" : "Opening…"} />
					) : mode === "create" ? (
						"Create Library"
					) : (
						"Open Library"
					)}
				</Button>
			</div>
		</form>
	);
};

interface BrokenViewProps {
	library: ServedLibrary;
	retry: "idle" | "checking" | "failed";
	onRetry: () => void;
	onRelocate: () => void;
}

const BrokenView = ({
	library,
	retry,
	onRetry,
	onRelocate,
}: BrokenViewProps) => {
	const inert = retry === "checking";
	return (
		<>
			<h1 className={card.title}>{library.name} isn’t reachable</h1>
			<div className={styles.pathLine}>
				<FolderGlyph />
				<span data-selectable>{library.path}</span>
			</div>
			<p className={styles.problem}>
				{library.problem ??
					"The server couldn’t open the library at this path."}{" "}
				If it lives on a drive or share that isn’t mounted, reconnect it, then
				retry.
			</p>
			<div className={card.actions}>
				<Button
					variant="primary"
					fullWidth
					disabled={inert}
					data-autofocus="true"
					onClick={onRetry}
				>
					{inert ? <BusyLabel text="Checking…" /> : "Retry"}
				</Button>
			</div>
			{retry === "failed" && (
				<div className={card.retryNote}>Still not reachable.</div>
			)}
			<div className={card.divider} />
			<div className={clsx(card.crossover, card.escapesAfterDivider)}>
				<Button
					variant="subtle"
					className={card.escapeBtn}
					disabled={inert}
					onClick={onRelocate}
				>
					It Moved — Choose the New Location…
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
	snapshot: SetupSnapshot,
	send: WebSetupFlowState["send"],
	announce: (text: string) => void,
	reduced: boolean,
	copy: CopyText,
): ResolvedView | null => {
	const { step } = snapshot;
	const hasFound =
		snapshot.found.libraries.length > 0 || snapshot.found.createIn.length > 0;
	switch (step.id) {
		case "loading":
			return {
				key: "loading",
				label: "Checking the server",
				hasBack: false,
				node: <LoadingView />,
			};
		case "address":
			return {
				key: "address",
				label: "Public URL",
				hasBack: false,
				node: (
					<AddressView
						urls={step.urls}
						typed={step.typed}
						checking={step.checking}
						stillMissing={step.stillMissing}
						error={step.error}
						copied={copy.copied}
						onType={(url) => send({ type: "ADDRESS_TYPED", url })}
						onCopy={copy.copy}
						onCheck={() => send({ type: "ADDRESS_CHECK" })}
						onDone={() => send({ type: "ADDRESS_DONE" })}
					/>
				),
			};
		case "unavailable":
			return {
				key: "unavailable",
				label: "Couldn’t reach the server",
				hasBack: false,
				node: (
					<UnavailableView
						message={step.message}
						onRetry={() => send({ type: "RETRY" })}
					/>
				),
			};
		case "chooser":
			return {
				key: "chooser",
				label: "Set up your library",
				hasBack: false,
				node: (
					<ChooserView
						disabled={false}
						lede={
							hasFound
								? "Found in the folders mounted for libraries:"
								: "Your books live in a Calibre‑compatible library."
						}
						adoptDescription="Use a Calibre library already on the server."
						createDescription="Make an empty library on the server."
						onAdopt={() => send({ type: "CHOOSE_ADOPT" })}
						onStartNew={() => send({ type: "CHOOSE_CREATE" })}
						found={
							hasFound ? (
								<FoundChoices
									found={snapshot.found}
									onUse={(path) => send({ type: "USE_FOUND", path })}
									onCreateIn={(path) => send({ type: "CREATE_IN", path })}
								/>
							) : undefined
						}
					/>
				),
			};
		case "broken":
			return {
				key: "broken",
				label: `${step.library.name} isn’t reachable`,
				hasBack: false,
				node: (
					<BrokenView
						library={step.library}
						retry={step.retry}
						onRetry={() => send({ type: "RETRY" })}
						onRelocate={() => send({ type: "CHOOSE_ADOPT" })}
					/>
				),
			};
		case "path": {
			const result = verdict(step.mode, step.inspection, step.checking);
			return {
				key: `path:${step.mode}`,
				label:
					step.mode === "create" ? "New library" : "Use an existing library",
				hasBack: true,
				node: (
					<PathView
						mode={step.mode}
						path={step.path}
						verdict={result}
						inspectionLibrary={step.inspection?.library ?? null}
						inspectionStatus={step.inspection?.status ?? null}
						busy={step.checking && step.continueWhenChecked}
						error={step.error}
						browser={step.browser}
						onPathChange={(path) => send({ type: "PATH_CHANGED", path })}
						onContinue={() => send({ type: "CONTINUE" })}
						onSwitchMode={() => send({ type: "SWITCH_MODE" })}
						onOpenBrowser={() => send({ type: "OPEN_BROWSER" })}
						onBrowseTo={(path) => send({ type: "BROWSE_TO", path })}
						onPick={(path) => send({ type: "PICK", path })}
						onCloseBrowser={() => send({ type: "CLOSE_BROWSER" })}
						onBack={() => send({ type: "BACK" })}
					/>
				),
			};
		}
		case "confirm":
			return {
				key: `confirm:${step.mode}`,
				label:
					step.mode === "create" ? "Name your library" : "Open this library",
				hasBack: true,
				node: (
					<ConfirmView
						mode={step.mode}
						path={step.path}
						name={step.name}
						upgradeAvailable={
							step.inspection.library?.upgradeAvailable ?? false
						}
						upgrade={step.upgrade}
						readOnly={step.readOnly}
						readOnlyForced={mustBeReadOnly(step.inspection)}
						readOnlyReason={step.inspection.library?.readOnlyReason ?? null}
						busy={step.busy}
						error={step.error}
						onNameChange={(name) => send({ type: "NAME_CHANGED", name })}
						onUpgradeChange={(upgrade) =>
							send({ type: "UPGRADE_CHANGED", upgrade })
						}
						onReadOnlyChange={(readOnly) =>
							send({ type: "READ_ONLY_CHANGED", readOnly })
						}
						onCommit={() => send({ type: "COMMIT" })}
						onBack={() => send({ type: "BACK" })}
					/>
				),
			};
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
		case "done":
			return null;
	}
};

/* -------------------------------- flow ---------------------------------- */

export interface WebSetupFlowProps {
	/** Called once the card has dissolved after the library was chosen. */
	onFinished: () => void;
}

/** The administrator's setup card over the window background. */
export const WebSetupFlow = ({ onFinished }: WebSetupFlowProps) => {
	const { snapshot, send } = useWebSetupFlow();
	const reduced = usePrefersReducedMotion();
	const [announced, setAnnounced] = useState("");
	const announce = useCallback((text: string) => setAnnounced(text), []);

	const done = snapshot.step.id === "done";
	const copy = useCopyText();
	const resolved = resolveView(snapshot, send, announce, reduced, copy);

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

	const label = resolved?.label;
	useEffect(() => {
		if (label) setAnnounced(label);
	}, [label]);

	useEffect(() => {
		if (!done) return;
		const timer = setTimeout(onFinished, reduced ? 0 : HANDOFF_MS);
		return () => clearTimeout(timer);
	}, [done, reduced, onFinished]);

	return (
		<div className={clsx(card.layer, done && card.layerHandoff)}>
			{resolved && (
				<MorphCard
					viewKey={resolved.key}
					label={resolved.label}
					hasBack={resolved.hasBack}
				>
					{resolved.node}
				</MorphCard>
			)}
			<span className={card.sr} role="status" aria-live="polite">
				{announced}
			</span>
		</div>
	);
};
