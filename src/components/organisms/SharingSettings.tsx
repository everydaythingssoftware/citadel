//! The sharing pane: server toggle, scope, port, reader sign-in, device keys.
//!
//! Design contract (ADR 0013):
//! - The backend owns server truth; the pane renders status and config from
//!   the service, never local guesses.
//! - Readers sign in with the username and a per-device key. Keys are
//!   generated and shown once, in a sheet that closes only through Done, and
//!   kept only as hashes. Rotate and revoke are press-and-hold.
//! - Scope and port changes reconfigure a running server; sign-in off just
//!   means "not required" and never deletes the keys.
//! - Secondary text sits under a row's label, never under its control.

import clsx from "clsx";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OpdsLifecycleState } from "@/bindings";
import { TablerCopy } from "@/components/icons/TablerCopy";
import { DeviceKeySheet } from "@/components/organisms/DeviceKeySheet";
import panes from "@/components/organisms/SettingsPanes.module.css";
import classes from "@/components/organisms/SharingSettings.module.css";
import {
	Button,
	HoldButton,
	SegmentedControl,
	Switch,
	TextInput,
} from "@/components/ui";
import { useDeviceKeySheet } from "@/lib/hooks/use-device-key-sheet";
import type { SharingError } from "@/lib/hooks/use-opds-sharing";
import {
	SHARING_ERROR_SOURCE,
	useOpdsSharing,
} from "@/lib/hooks/use-opds-sharing";
import { usePlatform } from "@/lib/platform/context";
import type { SharingSettings as SharingPreferences } from "@/lib/platform/settings/types";
import { deviceKeyUsage } from "@/lib/services/opds/device-keys";
import { useSettings } from "@/stores/settings/store";

/** Copied state lifetime. */
const COPIED_MS = 1_500;
/** Shown in place of the URL while the service is on but not yet serving. */
const PENDING_LABEL = {
	starting: "Starting…",
	waitingForInterface: "Waiting for a network connection…",
} as const satisfies Partial<Record<OpdsLifecycleState, string>>;
/** Matches the sign-in-emphasis animation in the module CSS. */
const SIGN_IN_EMPHASIS_MS = 1_200;
const PORT_RANGE_MESSAGE = "Choose a port from 1 to 65535.";
/** HTTP Basic splits `user:pass` at the first colon; the backend rejects it too. */
const USERNAME_FORBIDDEN = ":";

interface RowProps {
	label: string;
	htmlFor?: string;
	description?: string | null;
	error?: string | null;
	className?: string;
	children: ReactNode;
}

/** One setting: an error takes the description's place, in the same slot. */
const Row = ({
	label,
	htmlFor,
	description,
	error,
	className,
	children,
}: RowProps) => (
	<div className={clsx(panes.row, className)}>
		<div className={panes.rowLabels}>
			{htmlFor ? (
				<label className={panes.rowLabel} htmlFor={htmlFor}>
					{label}
				</label>
			) : (
				<span className={panes.rowLabel}>{label}</span>
			)}
			{error ? (
				<span
					className={`${panes.rowDescription} ${classes.errorText}`}
					role="alert"
				>
					{error}
				</span>
			) : (
				description && (
					<span className={panes.rowDescription}>{description}</span>
				)
			)}
		</div>
		{children}
	</div>
);

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
	const keysHeadingId = useId();
	const [portInput, setPortInput] = useState(String(sharing.port));
	/** Why the last port change was rolled back; outlives the restart that
	 * clears the service error. */
	const [portError, setPortError] = useState<SharingError | null>(null);
	const [usernameInput, setUsernameInput] = useState("");
	const [usernameDirty, setUsernameDirty] = useState(false);
	/** Which control a credential error belongs to while no sheet is open. */
	const [renameFailed, setRenameFailed] = useState(false);
	const [signInEmphasized, setSignInEmphasized] = useState(false);
	const [urlCopied, setUrlCopied] = useState(false);
	const portFocusedRef = useRef(false);
	const reconfiguringRef = useRef(false);
	const urlCopiedTimer = useRef<number | null>(null);
	const emphasisTimer = useRef<number | null>(null);
	const addDeviceRef = useRef<HTMLButtonElement>(null);

	const status = controller.status;
	const shareOn =
		status?.state === "running" ||
		status?.state === "starting" ||
		status?.state === "waitingForInterface";
	const keys = controller.deviceKeys?.keys ?? [];
	const storedUsername = controller.deviceKeys?.username ?? "";
	const credentialsConfigured = keys.length > 0;
	const allNetworksUnlocked = sharing.authenticationEnabled;
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
			for (const timer of [urlCopiedTimer, emphasisTimer]) {
				if (timer.current !== null) window.clearTimeout(timer.current);
			}
		},
		[],
	);

	// The backend owns the username (single source of truth); the field
	// mirrors it until the user edits, and re-syncs if another window renames.
	useEffect(() => {
		if (!usernameDirty) setUsernameInput(storedUsername);
	}, [storedUsername, usernameDirty]);

	const sheet = useDeviceKeySheet({
		createDeviceKey: controller.createDeviceKey,
		rotateDeviceKey: controller.rotateDeviceKey,
		clearError: controller.clearError,
		copyText: (text) => platform.clipboard.writeText(text),
	});

	const toggleShare = async (on: boolean) => {
		setPortError(null);
		if (!on) {
			await controller.stop();
			return;
		}
		await controller.start({
			target: sharing.target,
			port: portValid ? port : sharing.port,
			authenticationEnabled: sharing.authenticationEnabled,
		});
	};

	// A click on the locked All networks segment points at what unlocks it.
	const pointAtSignIn = () => {
		setSignInEmphasized(true);
		if (emphasisTimer.current !== null)
			window.clearTimeout(emphasisTimer.current);
		emphasisTimer.current = window.setTimeout(() => {
			emphasisTimer.current = null;
			setSignInEmphasized(false);
		}, SIGN_IN_EMPHASIS_MS);
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
		// Off is just "not required": the keys stay, so turning sign-in back
		// on lets the same devices in again.
		let target = sharing.target;
		if (!on && target === "allInterfaces") {
			// All-networks sharing cannot exist without sign-in.
			target = "localNetworks";
		}
		await persist({ authenticationEnabled: on, target });
		if (shareOn) {
			await controller.reconfigure({
				target,
				port: portValid ? port : sharing.port,
				authenticationEnabled: on,
			});
		}
	};

	const settleUsername = () => {
		const username = usernameInput.trim();
		if (usernameInvalid) return;
		setUsernameDirty(false);
		if (!username || username === storedUsername) {
			setUsernameInput(storedUsername);
			return;
		}
		setRenameFailed(false);
		void controller.renameUser(username).then((ok) => {
			setRenameFailed(!ok);
			if (!ok) setUsernameInput(storedUsername);
		});
	};

	const rotateKey = (keyId: string) => {
		setRenameFailed(false);
		void sheet.rotate(keyId);
	};

	const revokeKey = (keyId: string) => {
		setRenameFailed(false);
		void controller.revokeDeviceKey(keyId);
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

	const serverError =
		portError ??
		(controller.error?.source === SHARING_ERROR_SOURCE.server
			? controller.error
			: null);
	const credentialError =
		controller.error?.source === SHARING_ERROR_SOURCE.credentials
			? controller.error.message
			: null;
	const portRejected = serverError?.code === "portUnavailable";
	const portMessage = !portValid
		? PORT_RANGE_MESSAGE
		: portRejected
			? serverError.message
			: null;
	const shareError = serverError && !portRejected ? serverError.message : null;
	const usernameError = usernameInvalid
		? "Usernames can't contain a colon."
		: renameFailed
			? credentialError
			: null;
	const keysError = !renameFailed && !sheet.open ? credentialError : null;
	const listenUrl = status?.state === "running" ? status.urls[0] : undefined;
	const pendingLabel =
		status?.state === "starting" || status?.state === "waitingForInterface"
			? PENDING_LABEL[status.state]
			: null;

	if (!status) {
		return (
			<div className={panes.groups}>
				<p className={panes.paneNote}>Checking sharing status…</p>
				{controller.error && (
					<p className={panes.inlineNote} data-tone="error" role="alert">
						{controller.error.message}
					</p>
				)}
			</div>
		);
	}

	return (
		<div>
			<p className={panes.paneNote}>
				Let reader apps browse and download this library over OPDS.
			</p>
			<div className={panes.groups}>
				<div className={panes.group}>
					<Row label="Share library" htmlFor={shareSwitchId} error={shareError}>
						<Switch
							id={shareSwitchId}
							checked={shareOn}
							disabled={controller.isActing || !portValid}
							onCheckedChange={(on) => void toggleShare(on)}
						/>
					</Row>
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
					<Row label="Reachable from">
						<SegmentedControl
							aria-label="Reachable from"
							value={sharing.target}
							dimmed={!allNetworksUnlocked}
							onChange={(next) => {
								if (next === "localNetworks" || next === "allInterfaces") {
									changeTarget(next);
								}
							}}
							onLockedClick={pointAtSignIn}
							items={[
								{ value: "localNetworks", label: "Local network" },
								{
									value: "allInterfaces",
									label: "All networks",
									lockedReason: allNetworksUnlocked
										? undefined
										: "Requires sign-in",
								},
							]}
						/>
					</Row>
					<Row label="Port" htmlFor="sharing-port" error={portMessage}>
						<TextInput
							id="sharing-port"
							aria-invalid={portMessage ? true : undefined}
							className={`${classes.portInput} ${portMessage ? classes.invalid : ""}`}
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
					</Row>
				</div>

				<div className={panes.group}>
					<Row
						label="Require sign-in"
						htmlFor="sharing-signin"
						description="HTTP Basic Auth, supported by most reader apps."
						className={signInEmphasized ? classes.emphasized : undefined}
					>
						<Switch
							id="sharing-signin"
							checked={sharing.authenticationEnabled}
							disabled={controller.isActing}
							onCheckedChange={(on) => void toggleSignIn(on)}
						/>
					</Row>
					{sharing.authenticationEnabled && (
						<Row
							label="Username"
							htmlFor="sharing-username"
							description={
								usernameDirty && credentialsConfigured
									? "Change it on every reader too."
									: null
							}
							error={usernameError}
						>
							<TextInput
								id="sharing-username"
								aria-invalid={usernameError ? true : undefined}
								className={`${classes.usernameInput} ${usernameError ? classes.invalid : ""}`}
								value={usernameInput}
								spellCheck={false}
								autoCapitalize="off"
								onChange={(event) => {
									setUsernameDirty(true);
									setRenameFailed(false);
									setUsernameInput(event.currentTarget.value);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
								}}
								onBlur={settleUsername}
							/>
						</Row>
					)}
				</div>

				{sharing.authenticationEnabled && (
					<section aria-labelledby={keysHeadingId}>
						<h3 id={keysHeadingId} className={panes.sectionTitle}>
							Device passwords
						</h3>
						<div className={panes.group}>
							{keys.length === 0 && (
								<div className={panes.row}>
									<span className={panes.rowDescription}>
										Reader apps can't sign in until you add a device.
									</span>
									<Button
										ref={addDeviceRef}
										variant="primary"
										className={classes.addFirstDevice}
										onClick={sheet.startAdding}
									>
										Add Device…
									</Button>
								</div>
							)}
							{keys.map((key) => (
								<div key={key.id} className={`${panes.row} ${classes.keyRow}`}>
									<div className={panes.rowLabels}>
										<span className={panes.rowLabel}>{key.name}</span>
										<span className={panes.rowDescription}>
											{deviceKeyUsage(key)}
										</span>
									</div>
									<div className={classes.keyActions}>
										<HoldButton
											label="Rotate"
											hint="Hold to replace this password"
											tone="neutral"
											disabled={controller.isActing}
											onConfirm={() => rotateKey(key.id)}
										/>
										<HoldButton
											label="Revoke"
											hint="Hold to revoke this password"
											disabled={controller.isActing}
											onConfirm={() => revokeKey(key.id)}
										/>
									</div>
								</div>
							))}
							{keysError && (
								<div className={panes.row}>
									<span
										className={`${panes.rowDescription} ${classes.errorText}`}
										role="alert"
									>
										{keysError}
									</span>
								</div>
							)}
							{keys.length > 0 && (
								<div className={classes.keysFooter}>
									<Button
										ref={addDeviceRef}
										variant="subtle"
										className={classes.addDevice}
										onClick={sheet.startAdding}
									>
										+ Add Device…
									</Button>
								</div>
							)}
						</div>
					</section>
				)}
			</div>

			<DeviceKeySheet
				open={sheet.open}
				view={sheet.view}
				name={sheet.name}
				copied={sheet.copied}
				isActing={controller.isActing}
				error={credentialError}
				address={listenUrl ?? null}
				onNameChange={sheet.setName}
				onSubmitName={() => void sheet.submitName()}
				onCopyKey={() => void sheet.copyKey()}
				onClose={sheet.close}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					sheet.closed();
					addDeviceRef.current?.focus();
				}}
			/>
		</div>
	);
};
