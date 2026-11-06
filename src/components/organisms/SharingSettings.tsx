//! The sharing pane: server toggle, scope, port, reader sign-in.
//!
//! Design contract (ADR 0013 + the rows layout signed off by Phil):
//! - The backend owns server truth; the pane renders status and config from
//!   the service, never local guesses.
//! - Readers sign in with the username and a per-device key. Keys are
//!   generated, shown once when created or rotated, and kept only as hashes;
//!   rotate and revoke are press-and-hold.
//! - Scope and port changes reconfigure a running server; sign-in off just
//!   means "not required" and never deletes the keys.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DeviceKey, NewDeviceKey, OpdsLifecycleState } from "@/bindings";
import { TablerCopy } from "@/components/icons/TablerCopy";
import classes from "@/components/organisms/SharingSettings.module.css";
import { Button, HoldButton, SegmentedControl, Switch } from "@/components/ui";
import type { SharingError } from "@/lib/hooks/use-opds-sharing";
import {
	SHARING_ERROR_SOURCE,
	useOpdsSharing,
} from "@/lib/hooks/use-opds-sharing";
import { usePlatform } from "@/lib/platform/context";
import type { SharingSettings as SharingPreferences } from "@/lib/platform/settings/types";
import { useSettings } from "@/stores/settings/store";

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

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
});
const formatDate = (unixSeconds: number): string =>
	DATE_FORMAT.format(new Date(unixSeconds * 1_000));

export const deviceKeyUsage = (key: DeviceKey): string =>
	`Added ${formatDate(key.createdAt)} · ${
		key.lastUsedAt === null
			? "Never used"
			: `Last used ${formatDate(key.lastUsedAt)}`
	}`;

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
	const [usernameInput, setUsernameInput] = useState("");
	const [usernameDirty, setUsernameDirty] = useState(false);
	const [deviceName, setDeviceName] = useState("");
	/** The key just created or rotated: its secret is shown this once. */
	const [shownKey, setShownKey] = useState<NewDeviceKey | null>(null);
	const [urlCopied, setUrlCopied] = useState(false);
	const [keyCopied, setKeyCopied] = useState(false);
	const portFocusedRef = useRef(false);
	const reconfiguringRef = useRef(false);
	const urlCopiedTimer = useRef<number | null>(null);
	const keyCopiedTimer = useRef<number | null>(null);

	const status = controller.status;
	const shareOn =
		status?.state === "running" ||
		status?.state === "starting" ||
		status?.state === "waitingForInterface";
	const keys = controller.deviceKeys?.keys ?? [];
	const storedUsername = controller.deviceKeys?.username ?? "";
	const credentialsConfigured = keys.length > 0;
	const allNetworksUnlocked =
		sharing.authenticationEnabled && credentialsConfigured;
	const sharingNeedsKey =
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
			for (const timer of [urlCopiedTimer, keyCopiedTimer]) {
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
		if (!username || username === storedUsername) {
			setUsernameDirty(false);
			setUsernameInput(storedUsername);
			return;
		}
		setUsernameDirty(false);
		void controller.renameUser(username).then((ok) => {
			if (!ok) setUsernameInput(storedUsername);
		});
	};

	const showKey = (key: NewDeviceKey | null) => {
		if (!key) return;
		setShownKey(key);
		setKeyCopied(false);
	};

	const addDeviceKey = async () => {
		const name = deviceName.trim();
		if (!name) return;
		const created = await controller.createDeviceKey(name);
		if (created) setDeviceName("");
		showKey(created);
	};

	const rotateDeviceKey = async (key: DeviceKey) => {
		showKey(await controller.rotateDeviceKey(key.id));
	};

	const revokeDeviceKey = async (key: DeviceKey) => {
		if (shownKey?.key.id === key.id) setShownKey(null);
		await controller.revokeDeviceKey(key.id);
	};

	const copyKey = async (secret: string) => {
		await platform.clipboard.writeText(secret);
		setKeyCopied(true);
		if (keyCopiedTimer.current !== null)
			window.clearTimeout(keyCopiedTimer.current);
		keyCopiedTimer.current = window.setTimeout(() => {
			keyCopiedTimer.current = null;
			setKeyCopied(false);
		}, COPIED_MS);
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
							disabled={controller.isActing || !portValid || sharingNeedsKey}
							onCheckedChange={(on) => void toggleShare(on)}
						/>
						{sharingNeedsKey && (
							<p className={classes.fieldNote}>
								Add a device key below to enable sharing.
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
									onChange={(event) => {
										setUsernameDirty(true);
										setUsernameInput(event.currentTarget.value);
									}}
									onKeyDown={(event) => {
										if (event.key === "Enter") event.currentTarget.blur();
									}}
									onBlur={settleUsername}
								/>
								{usernameInvalid ? (
									<p className={classes.fieldError}>
										Usernames can't contain a colon (:).
									</p>
								) : (
									usernameDirty &&
									credentialsConfigured && (
										<p className={classes.fieldNote}>
											Every device signs in with this name. Change it on each of
											them too.
										</p>
									)
								)}
							</div>
						</div>
						{keys.map((key) => (
							<div key={key.id} className={classes.row}>
								<div>
									<span className={classes.keyName}>{key.name}</span>
									<p className={classes.rowNote}>{deviceKeyUsage(key)}</p>
								</div>
								<div className={classes.keyActions}>
									<HoldButton
										label="Rotate"
										hint="Hold to replace this key"
										disabled={controller.isActing}
										onConfirm={() => void rotateDeviceKey(key)}
									/>
									<HoldButton
										label="Revoke"
										hint="Hold to revoke this key"
										disabled={controller.isActing}
										onConfirm={() => void revokeDeviceKey(key)}
									/>
								</div>
							</div>
						))}
						{shownKey && (
							<div className={`${classes.row} ${classes.rowTop}`}>
								<div>
									<span className={classes.rowLabelText}>
										Key for {shownKey.key.name}
									</span>
									<p className={classes.rowNote}>
										Copy it now: it won't be shown again.
									</p>
								</div>
								<div className={classes.keyActions}>
									<button
										type="button"
										className={`${classes.urlChip} ${keyCopied ? classes.urlCopied : ""}`}
										aria-label={`Copy the key for ${shownKey.key.name}`}
										onClick={() => void copyKey(shownKey.secret)}
									>
										<code className={classes.mono}>{shownKey.secret}</code>
										<span className={classes.urlChipIcon} aria-hidden="true">
											<TablerCopy />
										</span>
									</button>
									<Button size="sm" onClick={() => setShownKey(null)}>
										{keyCopied ? "Copied" : "Done"}
									</Button>
								</div>
							</div>
						)}
						<div className={`${classes.row} ${classes.rowTop}`}>
							<div>
								<label htmlFor="sharing-device">Add a device</label>
								<p className={classes.rowNote}>
									One key per reader app, so each can be revoked alone.
								</p>
							</div>
							<div className={classes.controlStack}>
								<form
									className={classes.keyActions}
									onSubmit={(event) => {
										event.preventDefault();
										void addDeviceKey();
									}}
								>
									<input
										id="sharing-device"
										className={`${classes.fieldInput} ${classes.deviceInput}`}
										value={deviceName}
										placeholder="e.g. Kobo"
										spellCheck={false}
										onChange={(event) =>
											setDeviceName(event.currentTarget.value)
										}
									/>
									<Button
										type="submit"
										size="sm"
										disabled={controller.isActing || !deviceName.trim()}
									>
										Add Key
									</Button>
								</form>
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
