//! The sharing pane: server toggle, scope, port, reader sign-in.
//!
//! Design contract (ADR 0005 + the rows layout signed off by Phil):
//! - The backend owns server truth; the pane renders status and config from
//!   the service, never local guesses.
//! - Credentials are stored reversibly; the password field holds the real
//!   secret masked by default, with an eye toggle and a press-and-hold
//!   regenerate.
//! - Scope and port changes reconfigure a running server; sign-in off just
//!   means "not required" and never deletes the stored secret.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OpdsLifecycleState } from "@/bindings";
import { F7Eye } from "@/components/icons/F7Eye";
import { F7EyeSlash } from "@/components/icons/F7EyeSlash";
import { TablerCopy } from "@/components/icons/TablerCopy";
import { TablerRefresh } from "@/components/icons/TablerRefresh";
import classes from "@/components/organisms/SharingSettings.module.css";
import { SegmentedControl, Switch } from "@/components/ui";
import type { SharingError } from "@/lib/hooks/use-opds-sharing";
import {
	SHARING_ERROR_SOURCE,
	useOpdsSharing,
} from "@/lib/hooks/use-opds-sharing";
import { usePlatform } from "@/lib/platform/context";
import type { SharingSettings as SharingPreferences } from "@/lib/platform/settings/types";
import { useSettings } from "@/stores/settings/store";

/** Motion values tuned by Phil on the dial-in page. Durations here must
 *  match the keyframes in the module CSS. */
/** How long the regenerate button must be held before it fires. */
const HOLD_THRESHOLD_MS = 700;
/** 360° turn with an overshoot settle; also how long the fill fade state lives. */
const SPIN_MS = 620;
/** Early-release pill lifetime. */
const HINT_MS = 1_200;
/** Per-letter gold band (50% of the 1000ms wave) and letter stagger. */
const WASH_LETTER_MS = 500;
const WASH_STAGGER_MS = 42;
/** Copied state lifetime. */
const COPIED_MS = 1_500;
/** Shown in place of the URL while the service is on but not yet serving. */
const PENDING_LABEL = {
	starting: "Starting…",
	waitingForInterface: "Waiting for a network connection…",
} as const satisfies Partial<Record<OpdsLifecycleState, string>>;
/** The port row holds errors inline beside the field, so they stay short. */
const PORT_RANGE_MESSAGE = "Choose a port from 1 to 65535.";
const PORT_UNAVAILABLE_MESSAGE = "Port not available, please choose another";
const serverErrorMessage = (error: SharingError): string =>
	error.code === "portUnavailable" ? PORT_UNAVAILABLE_MESSAGE : error.message;
/** HTTP Basic splits `user:pass` at the first colon; the backend rejects it too. */
const USERNAME_FORBIDDEN = ":";

export const SharingSettings = () => {
	const platform = usePlatform();
	const supported = platform.capabilities.supportsLocalOpdsServer;
	const sharing = useSettings((state) => state.sharing);
	const setSharing = useSettings((state) => state.setSharing);
	const controller = useOpdsSharing(supported);

	if (!supported) {
		return (
			<div className={classes.unsupported}>
				<h3>Sharing requires the desktop app</h3>
				<p>
					The web version cannot run a local server. Open Citadel on macOS or
					another supported desktop to share this library.
				</p>
			</div>
		);
	}

	return (
		<SharingPane
			controller={controller}
			sharing={sharing}
			setSharing={setSharing}
		/>
	);
};

interface SharingPaneProps {
	sharing: SharingPreferences;
	setSharing: (next: SharingPreferences) => Promise<void>;
	controller: ReturnType<typeof useOpdsSharing>;
}

const SharingPane = ({ controller, sharing, setSharing }: SharingPaneProps) => {
	const platform = usePlatform();
	const shareSwitchId = useId();
	const [portInput, setPortInput] = useState(String(sharing.port));
	/** Why the last port change was rolled back; outlives the restart that
	 * clears the service error. */
	const [portError, setPortError] = useState<SharingError | null>(null);
	const [usernameInput, setUsernameInput] = useState("citadel");
	const [usernameDirty, setUsernameDirty] = useState(false);
	const [password, setPassword] = useState("");
	const [passwordRevealed, setPasswordRevealed] = useState(false);
	const [urlCopied, setUrlCopied] = useState(false);
	const [holding, setHolding] = useState(false);
	const [holdHint, setHoldHint] = useState(false);
	const [fired, setFired] = useState(false);
	// Bumped on every fire so a re-fire during a running spin/wave restarts
	// the animation (React remounts the keyed element).
	const [fireSeq, setFireSeq] = useState(0);
	const [passwordWash, setPasswordWash] = useState(false);
	const passwordRef = useRef<HTMLInputElement>(null);
	const committedRef = useRef<string>("");
	const portFocusedRef = useRef(false);
	const reconfiguringRef = useRef(false);
	const urlCopiedTimer = useRef<number | null>(null);
	const holdTimer = useRef<number | null>(null);
	const holdActive = useRef(false);
	const hintTimer = useRef<number | null>(null);
	const firedTimer = useRef<number | null>(null);
	const washTimer = useRef<number | null>(null);

	const status = controller.status;
	const shareOn =
		status?.state === "running" ||
		status?.state === "starting" ||
		status?.state === "waitingForInterface";
	const credentialsConfigured = controller.credentials.configured;
	const allNetworksUnlocked =
		sharing.authenticationEnabled && credentialsConfigured;
	const sharingNeedsPassword =
		sharing.authenticationEnabled && !credentialsConfigured;
	const usernameInvalid = usernameInput.includes(USERNAME_FORBIDDEN);
	const port = Number(portInput);
	const portValid = Number.isInteger(port) && port > 0 && port <= 65_535;

	const failedRef = useRef(false);
	useEffect(() => {
		failedRef.current = status?.state === "error";
	}, [status?.state]);
	const { stop } = controller;
	useEffect(
		() => () => {
			// Leaving the pane acknowledges a failed start: reset the service
			// to stopped so the stale error doesn't greet the next visit.
			if (failedRef.current) void stop();
		},
		[stop],
	);

	const persist = useCallback(
		(patch: Partial<SharingPreferences>) => {
			const current = useSettings.getState().sharing;
			return setSharing({ ...current, ...patch });
		},
		[setSharing],
	);

	// While sharing, the server's actual configuration is authoritative —
	// except while the user is editing the port field or a commit is still
	// applying (status lags one poll behind the settings during a restart).
	useEffect(() => {
		const livePort = status?.config?.port;
		if (!livePort || portFocusedRef.current || reconfiguringRef.current) return;
		if (livePort !== sharing.port) {
			setPortInput(String(livePort));
			void persist({ port: livePort });
		}
	}, [status?.config?.port, sharing.port, persist]);

	useEffect(() => setPortInput(String(sharing.port)), [sharing.port]);

	useEffect(
		() => () => {
			for (const timer of [
				urlCopiedTimer,
				holdTimer,
				hintTimer,
				firedTimer,
				washTimer,
			]) {
				if (timer.current !== null) window.clearTimeout(timer.current);
			}
		},
		[],
	);

	// The backend owns the username (single source of truth); the field
	// mirrors it until the user edits, and re-syncs if another window rotates.
	useEffect(() => {
		const stored = controller.credentials.username;
		if (!usernameDirty && stored) setUsernameInput(stored);
	}, [controller.credentials.username, usernameDirty]);

	// The stored secret is readable by design (ADR 0005): the field holds the
	// real password, masked by default and revealed with the eye toggle.
	// biome-ignore lint/correctness/useExhaustiveDependencies: credentialSecret is a stable callback; the controller object itself is rebuilt every render and must not be a dependency.
	useEffect(() => {
		if (!credentialsConfigured) return;
		let alive = true;
		void controller.credentialSecret().then((secret) => {
			if (!alive || !secret) return;
			setPassword(secret.password);
			committedRef.current = secret.password;
		});
		return () => {
			alive = false;
		};
	}, [
		credentialsConfigured,
		controller.credentials.username,
		controller.credentialSecret,
	]);

	const toggleShare = async (on: boolean) => {
		setPortError(null);
		if (on) {
			await controller.start({
				target: sharing.target,
				port: portValid ? port : sharing.port,
				authenticationEnabled: sharing.authenticationEnabled,
			});
			return;
		}
		await controller.stop();
	};

	const changeTarget = (target: "localNetworks" | "allInterfaces") => {
		setPortError(null);
		void persist({ target });
		if (shareOn) {
			void controller.reconfigure({
				target,
				port: portValid ? port : sharing.port,
				authenticationEnabled: sharing.authenticationEnabled,
			});
		}
	};

	const commitPort = async (event: React.FocusEvent<HTMLInputElement>) => {
		// The DOM value is the ground truth at blur time; state and refs can
		// lag if the last input event has not flushed through React yet.
		const latest = Number(event.currentTarget.value);
		if (!Number.isInteger(latest) || latest <= 0 || latest > 65_535) return;
		if (latest === sharing.port) return;
		const previous = sharing.port;
		setPortError(null);
		void persist({ port: latest });
		if (!shareOn) return;
		const scope = {
			target: sharing.target,
			authenticationEnabled: sharing.authenticationEnabled,
		};
		reconfiguringRef.current = true;
		try {
			const applied = await controller.reconfigure({ ...scope, port: latest });
			if (applied.ok) return;
			// A failed restart must not leave settings pointing at a port the
			// server never took, nor leave sharing down: go back to the port
			// that worked and keep the reason next to the field.
			setPortError(applied.error);
			void persist({ port: previous });
			setPortInput(String(previous));
			await controller.reconfigure({ ...scope, port: previous });
		} finally {
			reconfiguringRef.current = false;
		}
	};

	const toggleSignIn = async (on: boolean) => {
		setPortError(null);
		// Off is just "not required": the stored secret stays, so turning
		// sign-in back on restores the same password.
		let target = sharing.target;
		if (!on && target === "allInterfaces") {
			// All-networks sharing cannot exist without sign-in.
			target = "localNetworks";
		}
		await persist({ authenticationEnabled: on, target });
		setPasswordRevealed(false);
		if (shareOn) {
			await controller.reconfigure({
				target,
				port: portValid ? port : sharing.port,
				authenticationEnabled: on,
			});
		}
	};

	const settlePassword = (event: React.FocusEvent<HTMLInputElement>) => {
		// The DOM value is the ground truth at blur time.
		const value = event.currentTarget.value;
		if (value === committedRef.current) return;
		if (!value.trim()) {
			revertPassword();
			return;
		}
		void persist({ username: usernameInput.trim() });
		void controller
			.configureCredentials({ username: usernameInput.trim(), password: value })
			.then((ok) => {
				// On failure the field snaps back to the secret the server
				// actually holds instead of lying about the commit.
				if (ok) {
					committedRef.current = value;
				} else {
					revertPassword();
				}
			});
	};

	const revertPassword = () => {
		setPassword(committedRef.current);
	};

	const settleUsername = () => {
		const username = usernameInput.trim();
		if (usernameInvalid) return;
		if (!username || username === controller.credentials.username) {
			setUsernameDirty(false);
			return;
		}
		// Nothing stored yet: the first generate or password commit carries it.
		if (!committedRef.current) return;
		setUsernameDirty(false);
		void controller
			.configureCredentials({ username, password: committedRef.current })
			.then((ok) => {
				if (!ok) setUsernameInput(controller.credentials.username ?? username);
			});
	};

	const copyUrl = async (url: string) => {
		await platform.clipboard.writeText(url);
		setUrlCopied(true);
		if (urlCopiedTimer.current !== null)
			window.clearTimeout(urlCopiedTimer.current);
		urlCopiedTimer.current = window.setTimeout(() => {
			urlCopiedTimer.current = null;
			setUrlCopied(false);
		}, COPIED_MS);
	};

	const fireRegenerate = async () => {
		const username = usernameInput.trim();
		if (!username || usernameInvalid) return;
		// Fire beat: fill holds at full size and fades while the icon turns.
		setFireSeq((seq) => seq + 1);
		setFired(true);
		if (firedTimer.current !== null) window.clearTimeout(firedTimer.current);
		firedTimer.current = window.setTimeout(() => {
			firedTimer.current = null;
			setFired(false);
		}, SPIN_MS);
		const generated = await controller.generateCredentials(username);
		if (!generated) return;
		setPassword(generated);
		setPasswordRevealed(true);
		committedRef.current = generated;
		// The wave runs over the new, revealed glyphs only — never over the
		// masked field, so the overlay cannot leak a hidden password.
		setPasswordWash(true);
		if (washTimer.current !== null) window.clearTimeout(washTimer.current);
		washTimer.current = window.setTimeout(
			() => {
				washTimer.current = null;
				setPasswordWash(false);
			},
			WASH_LETTER_MS + WASH_STAGGER_MS * Math.max(0, generated.length - 1) + 60,
		);
	};

	const showHoldHint = () => {
		setHoldHint(true);
		if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
		hintTimer.current = window.setTimeout(() => {
			hintTimer.current = null;
			setHoldHint(false);
		}, HINT_MS);
	};

	// Press-and-hold regenerate: an accidental click never rotates the
	// password. A release before the threshold explains itself with the pill;
	// leaving the button or a cancelled pointer aborts silently.
	const beginHold = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (holdActive.current || event.button !== 0) return;
		holdActive.current = true;
		setHolding(true);
		holdTimer.current = window.setTimeout(() => {
			holdTimer.current = null;
			holdActive.current = false;
			setHolding(false);
			void fireRegenerate();
		}, HOLD_THRESHOLD_MS);
	};

	const endHold = (early: boolean) => {
		if (!holdActive.current) return;
		holdActive.current = false;
		if (holdTimer.current !== null) {
			window.clearTimeout(holdTimer.current);
			holdTimer.current = null;
		}
		setHolding(false);
		if (early) showHoldHint();
	};

	const portInvalid = !portValid;
	const serverError =
		portError ??
		(controller.error?.source === SHARING_ERROR_SOURCE.server
			? controller.error
			: null);
	const credentialError =
		controller.error?.source === SHARING_ERROR_SOURCE.credentials
			? controller.error
			: null;
	const portMessage = portInvalid
		? PORT_RANGE_MESSAGE
		: serverError && serverErrorMessage(serverError);
	const listenUrl = status?.state === "running" ? status.urls[0] : undefined;
	const pendingLabel =
		status?.state === "starting" || status?.state === "waitingForInterface"
			? PENDING_LABEL[status.state]
			: null;

	if (!status) {
		return (
			<div className={classes.stack}>
				<p className={classes.note}>Checking sharing status…</p>
				{controller.error && (
					<p className={classes.fieldError} role="alert">
						{controller.error.message}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className={classes.stack}>
			<div className={classes.intro}>
				<h3 className={classes.sectionTitle}>Sharing</h3>
				<p className={classes.note}>
					Let OPDS reader apps browse and download from Citadel.
				</p>
			</div>

			<div className={classes.card}>
				<div className={`${classes.row} ${classes.rowTop}`}>
					<label htmlFor={shareSwitchId}>Share library</label>
					<div className={classes.controlStack}>
						<Switch
							id={shareSwitchId}
							checked={shareOn}
							disabled={
								controller.isActing || !portValid || sharingNeedsPassword
							}
							onCheckedChange={(on) => void toggleShare(on)}
						/>
						{sharingNeedsPassword && (
							<p className={classes.fieldNote}>
								Set a password below to enable sharing.
							</p>
						)}
					</div>
				</div>
				{pendingLabel && (
					<div className={classes.rowListen}>
						<p className={classes.listen}>{pendingLabel}</p>
					</div>
				)}
				{listenUrl && (
					<div className={classes.rowListen}>
						<p className={classes.listen}>
							Listening on
							<button
								type="button"
								className={`${classes.urlChip} ${urlCopied ? classes.urlCopied : ""}`}
								aria-label={`Copy ${listenUrl}`}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => void copyUrl(listenUrl)}
							>
								<code>{listenUrl}</code>
								<span className={classes.urlChipIcon} aria-hidden="true">
									{urlCopied ? (
										<svg
											className={classes.urlCheck}
											aria-hidden="true"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.5"
											strokeLinecap="round"
										>
											<path d="M4 12.5l5 5L20 6.5" />
										</svg>
									) : (
										<TablerCopy />
									)}
								</span>
							</button>
							<span className={classes.urlCopyLabel} data-copied={urlCopied}>
								<span>Copy</span>
								<span>Copied</span>
							</span>
						</p>
					</div>
				)}
				<div className={`${classes.row} ${classes.rowTop}`}>
					<span className={classes.rowLabelText}>Reachable from</span>
					<div className={classes.controlStack}>
						<SegmentedControl
							aria-label="Reachable from"
							value={sharing.target}
							onChange={(next) => {
								if (
									next === "localNetworks" ||
									(next === "allInterfaces" && allNetworksUnlocked)
								) {
									changeTarget(next);
								}
							}}
							items={[
								{ value: "localNetworks", label: "Local network" },
								{
									value: "allInterfaces",
									label: "All networks",
									disabled: !allNetworksUnlocked,
								},
							]}
						/>
						{!allNetworksUnlocked && (
							<p className={classes.fieldNote}>
								All networks requires reader sign-in.
							</p>
						)}
					</div>
				</div>
				<div className={classes.row}>
					<label htmlFor="sharing-port">Port</label>
					{portMessage && (
						<p className={classes.inlineError} role="alert">
							{portMessage}
						</p>
					)}
					<input
						id="sharing-port"
						aria-invalid={portMessage ? true : undefined}
						className={`${classes.portInput} ${portMessage ? classes.inputError : ""}`}
						inputMode="numeric"
						value={portInput}
						onFocus={() => {
							portFocusedRef.current = true;
						}}
						onBlur={(event) => {
							portFocusedRef.current = false;
							void commitPort(event);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}}
						onChange={(event) => {
							const value = event.currentTarget.value;
							if (!/^\d*$/.test(value)) return;
							setPortInput(value);
							setPortError(null);
							// Editing the port acknowledges a failed start, the same
							// as leaving the pane: reset the service to stopped.
							if (status.state === "error") void controller.stop();
						}}
					/>
				</div>
			</div>

			<div className={classes.card}>
				<div className={classes.row}>
					<div>
						<label htmlFor="sharing-signin">Require sign-in</label>
						<p className={classes.rowNote}>
							HTTP Basic authentication, supported by most readers.
						</p>
					</div>
					<Switch
						id="sharing-signin"
						checked={sharing.authenticationEnabled}
						disabled={controller.isActing}
						onCheckedChange={(on) => void toggleSignIn(on)}
					/>
				</div>
				{sharing.authenticationEnabled && (
					<>
						<div className={`${classes.row} ${classes.rowTop}`}>
							<label htmlFor="sharing-username">Username</label>
							<div className={classes.controlStack}>
								<input
									id="sharing-username"
									className={`${classes.fieldInput} ${usernameInvalid ? classes.inputError : ""}`}
									value={usernameInput}
									spellCheck={false}
									autoCapitalize="off"
									onChange={(event) =>
										setUsernameInput(event.currentTarget.value)
									}
									onBlur={settleUsername}
								/>
								{usernameInvalid && (
									<p className={classes.fieldError}>
										Usernames can't contain a colon (:).
									</p>
								)}
							</div>
						</div>
						<div className={`${classes.row} ${classes.rowTop}`}>
							<label htmlFor="sharing-password">Password</label>
							<div className={classes.controlStack}>
								{/* The pill mounts on this wrapper, outside the
								    overflow-hidden shell, so it is never clipped. */}
								<div className={classes.shellWrap}>
									<div
										className={`${classes.fieldShell} ${passwordWash ? classes.washing : ""}`}
									>
										<input
											id="sharing-password"
											ref={passwordRef}
											className={`${classes.fieldInput} ${classes.fieldBare} ${classes.mono} ${passwordWash ? classes.washTarget : ""}`}
											type={passwordRevealed ? "text" : "password"}
											value={password}
											placeholder="Generate or type one"
											spellCheck={false}
											autoCapitalize="off"
											onChange={(event) =>
												setPassword(event.currentTarget.value)
											}
											onKeyDown={(event) => {
												if (event.key === "Enter") {
													event.currentTarget.blur();
												}
												if (event.key === "Escape") {
													revertPassword();
												}
											}}
											onBlur={settlePassword}
										/>
										{passwordWash && passwordRevealed && (
											<span
												key={fireSeq}
												className={classes.washOverlay}
												aria-hidden="true"
											>
												{Array.from(password).map((char, index) => (
													<span
														// biome-ignore lint/suspicious/noArrayIndexKey: static glyph sequence for one wave
														key={index}
														style={{
															animationDelay: `${index * WASH_STAGGER_MS}ms`,
														}}
													>
														{char}
													</span>
												))}
											</span>
										)}
										<button
											type="button"
											className={classes.inlineIcon}
											title={
												passwordRevealed ? "Hide password" : "Show password"
											}
											aria-label={
												passwordRevealed ? "Hide password" : "Show password"
											}
											onClick={() => setPasswordRevealed(!passwordRevealed)}
										>
											{passwordRevealed ? <F7EyeSlash /> : <F7Eye />}
										</button>
										<button
											type="button"
											className={`${classes.holdButton} ${holding ? classes.holding : ""} ${fired ? classes.fired : ""}`}
											title="Hold to regenerate"
											aria-label="Hold to regenerate password"
											disabled={
												controller.isActing ||
												!usernameInput.trim() ||
												usernameInvalid
											}
											onPointerDown={beginHold}
											onPointerUp={() => endHold(true)}
											onPointerLeave={() => endHold(false)}
											onPointerCancel={() => endHold(false)}
											onKeyDown={(event) => {
												if (event.key !== "Enter") return;
												event.preventDefault();
												if (holdActive.current) return;
												void fireRegenerate();
											}}
										>
											<span className={classes.holdFill} aria-hidden="true" />
											<span key={fireSeq} className={classes.holdIcon}>
												<TablerRefresh />
											</span>
										</button>
									</div>
									{holdHint && (
										<span className={classes.holdHint} role="status">
											Hold to regenerate
										</span>
									)}
								</div>
								{credentialError && (
									<p className={classes.fieldError} role="alert">
										{credentialError.message}
									</p>
								)}
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
};
