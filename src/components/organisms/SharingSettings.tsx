import type { OpdsLifecycleState, OpdsServiceStatus } from "@/bindings";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { TablerCopy } from "@/components/icons/TablerCopy";
import classes from "@/components/organisms/SharingSettings.module.css";
import { Button, Select, Switch, TextInput } from "@/components/ui";
import { useOpdsSharing } from "@/lib/hooks/use-opds-sharing";
import {
	hasValidationErrors,
	isOperationalStatus,
	passwordFreeSettings,
	selectedInterfaceUnavailable,
	sharingTargetOptions,
	targetFromValue,
	targetValue,
	validateSharing,
} from "@/lib/opds-sharing";
import type { SharingSettings as SharingPreferences } from "@/lib/platform/settings/types";
import { usePlatform } from "@/lib/platform/context";
import { useSettings } from "@/stores/settings/store";

const STATUS_LABELS: Record<OpdsLifecycleState, string> = {
	stopped: "Not sharing",
	starting: "Starting",
	running: "Sharing",
	waitingForInterface: "Waiting for network",
	error: "Needs attention",
	stopping: "Stopping",
};

const targetLabel = (status: OpdsServiceStatus): string => {
	if (!status.target) return "Not selected";
	return status.target.type === "allLocalNetworks"
		? "All local networks"
		: status.target.id;
};

export const SharingSettings = () => {
	const platform = usePlatform();
	const supported = platform.capabilities.supportsLocalOpdsServer;
	const sharing = useSettings((state) => state.sharing);
	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const libraries = useSettings((state) => state.libraryPaths);
	const setSharing = useSettings((state) => state.setSharing);
	const controller = useOpdsSharing(supported);
	const [portInput, setPortInput] = useState(String(sharing.port));
	const [password, setPassword] = useState("");
	const [generatedPassword, setGeneratedPassword] = useState<string | null>(
		null,
	);
	const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
	const authSwitchId = useId();

	useEffect(() => setPortInput(String(sharing.port)), [sharing.port]);

	const currentLibrary = libraries.find(
		(library) => library.id === activeLibraryId,
	);
	const options = useMemo(
		() => sharingTargetOptions(controller.interfaces, sharing.target),
		[controller.interfaces, sharing.target],
	);
	const unavailable = selectedInterfaceUnavailable(
		controller.interfaces,
		sharing.target,
	);
	const draft = useMemo<SharingPreferences>(
		() => ({ ...sharing, port: Number(portInput) }),
		[sharing, portInput],
	);
	const validation = validateSharing({
		settings: draft,
		password,
		credentialsConfigured: controller.credentials.configured,
		configuredUsername: controller.credentials.username,
	});
	const operational = isOperationalStatus(controller.status);
	const passwordConfigured =
		controller.credentials.configured &&
		controller.credentials.username === sharing.username.trim();

	const persist = useCallback(
		(patch: Partial<SharingPreferences>) => {
			const current = useSettings.getState().sharing;
			return setSharing(passwordFreeSettings({ ...current, ...patch }));
		},
		[setSharing],
	);

	const handleStart = useCallback(async () => {
		if (hasValidationErrors(validation)) return;
		await persist({ port: draft.port });
		if (await controller.start(passwordFreeSettings(draft), password)) {
			setPassword("");
			setGeneratedPassword(null);
		}
	}, [controller, draft, password, persist, validation]);

	const generatePassword = useCallback(async () => {
		if (!sharing.username.trim()) return;
		const generated = await controller.generatePassword(sharing.username);
		if (!generated) return;
		setPassword("");
		setGeneratedPassword(generated);
	}, [controller, sharing.username]);

	const copy = useCallback(
		async (url: string) => {
			await platform.clipboard.writeText(url);
			setCopiedUrl(url);
			window.setTimeout(() => setCopiedUrl(null), 1_500);
		},
		[platform],
	);

	if (!supported) {
		return (
			<div className={classes.unsupported}>
				<h3>Sharing requires the desktop app</h3>
				<p>
					The web version cannot open a local network server. Open Citadel on
					macOS or another supported desktop to share this library.
				</p>
			</div>
		);
	}

	if (controller.isLoading && controller.status === null) {
		return <p className={classes.note}>Checking sharing status…</p>;
	}

	if (operational && controller.status) {
		return (
			<OperationalSharing
				status={controller.status}
				libraryName={currentLibrary?.displayName}
				isActing={controller.isActing}
				frontendError={controller.error}
				copiedUrl={copiedUrl}
				onCopy={copy}
				onStop={() => void controller.stop()}
			/>
		);
	}

	return (
		<div className={classes.stack}>
			<div>
				<h3 className={classes.sectionTitle}>Local network sharing</h3>
				<p className={classes.note}>
					Start an OPDS catalog for the active library. Sharing stops when
					Citadel quits and must be started again after each launch.
				</p>
			</div>

			<div className={classes.group}>
				<div className={classes.fieldRow}>
					<label htmlFor="sharing-network">Network</label>
					<Select
						id="sharing-network"
						value={targetValue(sharing.target)}
						onChange={(value) =>
							void persist({ target: targetFromValue(value) })
						}
						options={options}
						width={250}
					/>
				</div>
				<div className={classes.fieldRow}>
					<label htmlFor="sharing-port">Port</label>
					<TextInput
						id="sharing-port"
						className={classes.portInput}
						inputMode="numeric"
						value={portInput}
						error={validation.port}
						onChange={(event) => {
							const value = event.currentTarget.value;
							if (/^\d*$/.test(value)) setPortInput(value);
						}}
						onBlur={() => {
							const port = Number(portInput);
							if (Number.isInteger(port) && port > 0 && port <= 65_535) {
								void persist({ port });
							}
						}}
					/>
				</div>
			</div>

			{unavailable && (
				<p className={classes.warning} role="status">
					The selected interface is unavailable. Citadel can start in a waiting
					state and will bind only when that same interface returns.
				</p>
			)}

			<div className={classes.group}>
				<div className={classes.switchRow}>
					<div>
						<label htmlFor={authSwitchId}>Require a password</label>
						<p>Uses HTTP Basic authentication in supported OPDS readers.</p>
					</div>
					<Switch
						id={authSwitchId}
						checked={sharing.authenticationEnabled}
						onCheckedChange={(authenticationEnabled) =>
							void persist({ authenticationEnabled })
						}
					/>
				</div>
				{sharing.authenticationEnabled && (
					<div className={classes.credentials}>
						<TextInput
							label="Username"
							value={sharing.username}
							error={validation.username}
							onChange={(event) =>
								void persist({ username: event.currentTarget.value })
							}
						/>
						<div className={classes.passwordActions}>
							<Button
								size="sm"
								variant="default"
								disabled={controller.isActing || !sharing.username.trim()}
								onClick={() => void generatePassword()}
							>
								Generate Password
							</Button>
						</div>
						{generatedPassword && (
							<div className={classes.generatedPassword} role="status">
								<div>
									<strong>Generated password</strong>
									<code>{generatedPassword}</code>
								</div>
								<Button
									size="sm"
									variant="subtle"
									onClick={() => void copy(generatedPassword)}
								>
									<TablerCopy aria-hidden="true" />
									{copiedUrl === generatedPassword ? "Copied" : "Copy"}
								</Button>
							</div>
						)}
						<TextInput
							label={passwordConfigured ? "Replace password" : "Set password"}
							type="password"
							autoComplete="new-password"
							value={password}
							error={validation.password}
							onChange={(event) => setPassword(event.currentTarget.value)}
						/>
						<p className={classes.transientNote}>
							{passwordConfigured
								? "Credentials are saved. Leave this blank to keep the current password."
								: "Citadel saves only a non-recoverable password verifier, never the plaintext password."}
						</p>
					</div>
				)}
			</div>

			<div className={classes.warningBlock}>
				<strong>Plain HTTP on your network</strong>
				<p>
					Citadel does not use HTTPS for local sharing. Basic credentials are
					sent unencrypted in transit. Without a password, anyone who can reach
					one of the listed addresses can browse and download from the active
					library.
				</p>
			</div>

			{controller.error && (
				<p className={classes.error} role="alert">
					{controller.error}
				</p>
			)}
			<div className={classes.actions}>
				<Button
					variant="primary"
					disabled={controller.isActing || hasValidationErrors(validation)}
					onClick={() => void handleStart()}
				>
					{controller.isActing ? "Starting…" : "Start Sharing"}
				</Button>
			</div>
		</div>
	);
};

interface OperationalSharingProps {
	status: OpdsServiceStatus;
	libraryName?: string;
	isActing: boolean;
	frontendError: string | null;
	copiedUrl: string | null;
	onCopy: (url: string) => Promise<void>;
	onStop: () => void;
}

const OperationalSharing = ({
	status,
	libraryName,
	isActing,
	frontendError,
	copiedUrl,
	onCopy,
	onStop,
}: OperationalSharingProps) => (
	<div className={classes.stack}>
		<div className={classes.statusHeader}>
			<div>
				<span className={classes.status} data-state={status.state}>
					<span aria-hidden="true" />
					{STATUS_LABELS[status.state]}
				</span>
				<h3 className={classes.sectionTitle}>
					{status.state === "running"
						? "Your library is available"
						: "Local network sharing"}
				</h3>
			</div>
			<Button
				size="sm"
				variant="default"
				disabled={isActing || status.state === "stopping"}
				onClick={onStop}
			>
				{status.state === "stopping" ? "Stopping…" : "Stop Sharing"}
			</Button>
		</div>

		<div className={classes.details}>
			<div>
				<dt>Library</dt>
				<dd>{libraryName ?? "Active library"}</dd>
			</div>
			{status.activeLibraryId && (
				<div>
					<dt>Library ID</dt>
					<dd className={classes.mono}>{status.activeLibraryId}</dd>
				</div>
			)}
			<div>
				<dt>Network</dt>
				<dd>{targetLabel(status)}</dd>
			</div>
			<div>
				<dt>Port</dt>
				<dd>{status.port ?? "Unknown"}</dd>
			</div>
		</div>

		{status.error && (
			<div className={classes.statusMessage} role="status">
				<strong>{STATUS_LABELS[status.state]}</strong>
				<p>{status.error.message}</p>
			</div>
		)}

		{status.urls.length > 0 && (
			<div>
				<h4 className={classes.listTitle}>Catalog addresses</h4>
				<ul className={classes.urlList}>
					{status.urls.map((url) => (
						<li key={url}>
							<code>{url}</code>
							<Button
								size="sm"
								variant="subtle"
								aria-label={`Copy ${url}`}
								onClick={() => void onCopy(url)}
							>
								<TablerCopy aria-hidden="true" />
								{copiedUrl === url ? "Copied" : "Copy"}
							</Button>
						</li>
					))}
				</ul>
			</div>
		)}

		{frontendError && (
			<p className={classes.error} role="alert">
				{frontendError}
			</p>
		)}
	</div>
);
