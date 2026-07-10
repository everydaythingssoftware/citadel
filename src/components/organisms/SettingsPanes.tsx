import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useId, useRef, useState } from "react";
import { commands } from "@/bindings";
import { F7BookFill } from "@/components/icons/F7BookFill";
import { F7Gear } from "@/components/icons/F7Gear";
import { FluentLibraryFilled } from "@/components/icons/FluentLibraryFilled";
import type { AddLibraryResult } from "@/components/molecules/SwitchLibraryForm";
import { SwitchLibraryForm } from "@/components/molecules/SwitchLibraryForm";
import classes from "@/components/organisms/SettingsPanes.module.css";
import { Button, SegmentedControl, Switch, TextInput } from "@/components/ui";
import { ADOPT_INVALID_ERROR } from "@/lib/first-run/machine";
import { useAppUpdates } from "@/lib/hooks/use-app-updates";
import { getDescriptor } from "@/lib/metadata-providers/registry";
import type { ProviderId } from "@/lib/metadata-providers/types";
import { none, some } from "@/lib/option";
import { usePlatform } from "@/lib/platform/context";
import { applyColorScheme } from "@/lib/theme-manager";
import { createLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useAnySourceEnabled } from "@/stores/settings/metadata-providers";
import { useSettings } from "@/stores/settings/store";

const SETTINGS_TABS = ["general", "library", "integrations"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_META: Record<
	SettingsTab,
	{ label: string; icon: (className: string | undefined) => ReactNode }
> = {
	general: {
		label: "General",
		icon: (className) => <F7Gear className={className} />,
	},
	library: {
		label: "Library",
		icon: (className) => <FluentLibraryFilled className={className} />,
	},
	integrations: {
		label: "Metadata",
		icon: (className) => <F7BookFill className={className} />,
	},
};

interface SettingsPanesProps {
	/**
	 * Called when a pane wants to dismiss settings, e.g. after switching
	 * libraries. In the settings window this hides the window.
	 */
	onRequestClose?: () => void;
}

/**
 * Classic macOS preferences layout (iTerm2 / pre-Ventura System Preferences):
 * a centered icon-over-label tab strip across the top, a hairline divider,
 * then the active pane on the window chrome background. The window uses an
 * overlay title bar with the native title hidden (menu.rs), so the strip is
 * the top of the window and doubles as the drag region; the traffic lights
 * overlay its left edge.
 */
export const SettingsPanes = ({ onRequestClose }: SettingsPanesProps) => {
	const [activeTab, setActiveTab] = useState<SettingsTab>("general");
	const tabRefs = useRef<
		Partial<Record<SettingsTab, HTMLButtonElement | null>>
	>({});
	const baseId = useId();

	const tabId = (tab: SettingsTab) => `${baseId}-tab-${tab}`;
	const panelId = (tab: SettingsTab) => `${baseId}-panel-${tab}`;

	const close = useCallback(() => {
		onRequestClose?.();
	}, [onRequestClose]);

	const selectAndFocusTab = useCallback((tab: SettingsTab) => {
		setActiveTab(tab);
		tabRefs.current[tab]?.focus();
	}, []);

	// Automatic activation: arrows move both focus and selection, macOS style.
	const handleTabKeyDown = useCallback(
		(event: KeyboardEvent<HTMLButtonElement>) => {
			const index = SETTINGS_TABS.indexOf(activeTab);
			let next: SettingsTab | undefined;
			switch (event.key) {
				case "ArrowRight":
					next = SETTINGS_TABS[(index + 1) % SETTINGS_TABS.length];
					break;
				case "ArrowLeft":
					next =
						SETTINGS_TABS[
							(index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
						];
					break;
				case "Home":
					next = SETTINGS_TABS[0];
					break;
				case "End":
					next = SETTINGS_TABS[SETTINGS_TABS.length - 1];
					break;
				default:
					return;
			}
			event.preventDefault();
			if (next) selectAndFocusTab(next);
		},
		[activeTab, selectAndFocusTab],
	);

	return (
		<div className={classes.pane}>
			<div
				role="tablist"
				aria-label="Settings sections"
				className={classes.tabStrip}
				data-tauri-drag-region
			>
				{SETTINGS_TABS.map((tab) => (
					<button
						key={tab}
						ref={(node) => {
							tabRefs.current[tab] = node;
						}}
						type="button"
						role="tab"
						id={tabId(tab)}
						aria-selected={tab === activeTab}
						aria-controls={panelId(tab)}
						tabIndex={tab === activeTab ? 0 : -1}
						className={classes.tab}
						onClick={() => setActiveTab(tab)}
						onKeyDown={handleTabKeyDown}
					>
						<span className={classes.tabIcon} aria-hidden="true">
							{TAB_META[tab].icon(classes.tabIconGlyph)}
						</span>
						<span className={classes.tabLabel}>{TAB_META[tab].label}</span>
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id={panelId(activeTab)}
				aria-labelledby={tabId(activeTab)}
				className={classes.panel}
			>
				<div className={classes.panelInner}>
					{activeTab === "general" && <GeneralTab />}
					{activeTab === "library" && <LibraryTab closeSettings={close} />}
					{activeTab === "integrations" && <IntegrationsTab />}
				</div>
			</div>
		</div>
	);
};

interface SettingsRowProps {
	label: string;
	description?: string;
	control: ReactNode;
	/** When set, the row label becomes a <label> for that control id. */
	htmlFor?: string;
}

const SettingsRow = ({
	label,
	description,
	control,
	htmlFor,
}: SettingsRowProps) => {
	return (
		<div className={classes.row}>
			<div className={classes.rowLabels}>
				{htmlFor ? (
					<label className={classes.rowLabel} htmlFor={htmlFor}>
						{label}
					</label>
				) : (
					<span className={classes.rowLabel}>{label}</span>
				)}
				{description && (
					<span className={classes.rowDescription}>{description}</span>
				)}
			</div>
			{control}
		</div>
	);
};

const GeneralTab = () => {
	const theme = useSettings((state) => state.theme);
	const setTheme = useSettings((state) => state.setTheme);
	const autoUpdateCheckingEnabled = useSettings(
		(state) => state.autoUpdateCheckingEnabled,
	);
	const setAutoUpdateCheckingEnabled = useSettings(
		(state) => state.setAutoUpdateCheckingEnabled,
	);
	const autoUpdateSwitchId = useId();

	const platform = usePlatform();
	const supportsAutoUpdates = platform.capabilities.supportsAutoUpdates;
	const isCheckingForUpdates = useAppUpdates(
		(state) => state.isCheckingForUpdates,
	);
	const checkForUpdatesNow = useAppUpdates((state) => state.checkForUpdatesNow);

	const applyTheme = useCallback(
		(value: string) => {
			const scheme =
				value === "light" || value === "dark" ? value : ("auto" as const);
			applyColorScheme(scheme);
			void setTheme(scheme);
		},
		[setTheme],
	);

	return (
		<div className={classes.groups}>
			<div className={classes.group}>
				<SettingsRow
					label="Appearance"
					control={
						<SegmentedControl
							aria-label="Appearance"
							value={theme}
							onChange={applyTheme}
							items={[
								{ value: "auto", label: "Auto" },
								{ value: "light", label: "Light" },
								{ value: "dark", label: "Dark" },
							]}
						/>
					}
				/>
			</div>
			<div className={classes.group}>
				<SettingsRow
					label="Check for updates automatically"
					htmlFor={autoUpdateSwitchId}
					control={
						<Switch
							id={autoUpdateSwitchId}
							checked={autoUpdateCheckingEnabled}
							disabled={!supportsAutoUpdates}
							onCheckedChange={(checked) =>
								void setAutoUpdateCheckingEnabled(checked)
							}
						/>
					}
				/>
				<SettingsRow
					label="Software update"
					description={
						supportsAutoUpdates
							? undefined
							: "Updates are not supported on this platform."
					}
					control={
						<Button
							size="sm"
							variant="default"
							disabled={!supportsAutoUpdates || isCheckingForUpdates}
							onClick={() => void checkForUpdatesNow(supportsAutoUpdates)}
						>
							{isCheckingForUpdates ? "Checking…" : "Check for Updates…"}
						</Button>
					}
				/>
			</div>
		</div>
	);
};

interface LibraryTabProps {
	closeSettings: () => void;
}

const LibraryTab = ({ closeSettings }: LibraryTabProps) => {
	const libraries = useSettings((state) => state.libraryPaths);
	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const platform = usePlatform();

	const addNewLibraryByPath = useCallback(
		async (form: SwitchLibraryForm): Promise<AddLibraryResult> => {
			const isPathValidLibrary = await commands.clbQueryIsPathValidLibrary(
				form.libraryPath,
			);

			if (!isPathValidLibrary) {
				return { ok: false, message: ADOPT_INVALID_ERROR };
			}
			const newLibraryId = await createLibrary(form.libraryPath);
			await setActiveLibrary(newLibraryId);
			closeSettings();
			return { ok: true };
		},
		[closeSettings],
	);

	const selectExistingLibrary = useCallback(
		async (id: string) => {
			await setActiveLibrary(id);
			closeSettings();
		},
		[closeSettings],
	);

	if (!activeLibraryId) {
		return (
			<p className={classes.paneNote}>
				Something went wrong loading your libraries.
			</p>
		);
	}

	return (
		<div className={classes.groups}>
			<div className={classes.formGroup}>
				<SwitchLibraryForm
					currentLibraryId={activeLibraryId}
					libraries={libraries}
					onSubmit={addNewLibraryByPath}
					selectExistingLibrary={selectExistingLibrary}
					selectNewLibrary={async () => {
						const path = await platform.dialogs.openDirectory({
							title: "Select Calibre Library Folder",
						});
						return path !== null ? some(path) : none();
					}}
				/>
			</div>
		</div>
	);
};

interface TestResult {
	success: boolean;
	message: string;
}

const ProviderRow = ({ id }: { id: ProviderId }) => {
	const descriptor = getDescriptor(id);
	const config = useSettings((state) => state.metadataProviders.configs[id]);
	const setProviderEnabled = useSettings((state) => state.setProviderEnabled);
	const setProviderConfig = useSettings((state) => state.setProviderConfig);
	const switchId = useId();

	const enabled = config?.enabled ?? false;
	const requiresKey = descriptor.capabilities.requiresKey;
	const savedKey = config?.apiKey ?? "";
	const hasKey = savedKey.trim().length > 0;

	const [expanded, setExpanded] = useState(false);
	const [apiKeyInput, setApiKeyInput] = useState(savedKey);
	const [isTesting, setIsTesting] = useState(false);
	const [testResult, setTestResult] = useState<TestResult | null>(null);

	const status = requiresKey
		? hasKey
			? "Key saved"
			: "Add a key"
		: "No key needed";

	const handleTest = useCallback(async () => {
		setIsTesting(true);
		setTestResult(null);
		try {
			const result = await commands.clbCmdTestMetadataProvider(
				id,
				requiresKey ? apiKeyInput : "",
			);
			if (result.status === "ok") {
				setTestResult({
					success: result.data.is_valid,
					message: result.data.is_valid ? "Reachable." : result.data.message,
				});
			} else {
				setTestResult({ success: false, message: result.error });
			}
		} catch (error) {
			setTestResult({
				success: false,
				message: `Error: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		} finally {
			setIsTesting(false);
		}
	}, [id, requiresKey, apiKeyInput]);

	const handleSaveKey = useCallback(async () => {
		await setProviderConfig(id, {
			apiKey: apiKeyInput,
			enabled: apiKeyInput.trim().length > 0 ? true : enabled,
		});
		setTestResult(null);
	}, [id, apiKeyInput, enabled, setProviderConfig]);

	const handleClearKey = useCallback(async () => {
		setApiKeyInput("");
		await setProviderConfig(id, { apiKey: "", enabled: false });
		setTestResult(null);
	}, [id, setProviderConfig]);

	return (
		<div className={classes.providerRow}>
			<div className={classes.providerHeader}>
				<button
					type="button"
					className={classes.providerDisclosure}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${descriptor.displayName}`}
					onClick={() => setExpanded((open) => !open)}
				>
					<span className={classes.providerChevron} data-open={expanded}>
						›
					</span>
				</button>
				<div className={classes.rowLabels}>
					<span className={classes.rowLabel}>{descriptor.displayName}</span>
					<span className={classes.rowDescription}>{status}</span>
				</div>
				<Switch
					id={switchId}
					checked={enabled}
					aria-label={`Enable ${descriptor.displayName}`}
					onCheckedChange={(checked) => void setProviderEnabled(id, checked)}
				/>
			</div>
			{expanded && (
				<div className={classes.providerBody}>
					<p className={classes.rowDescription}>{descriptor.blurb}</p>
					{requiresKey ? (
						<>
							<TextInput
								className={classes.keyInput}
								type="password"
								placeholder="API key"
								aria-label={`${descriptor.displayName} API key`}
								value={apiKeyInput}
								onChange={(event) => setApiKeyInput(event.currentTarget.value)}
							/>
							<div className={classes.rowActions}>
								<Button
									size="sm"
									variant="default"
									disabled={!apiKeyInput || isTesting}
									onClick={() => void handleClearKey()}
								>
									Clear
								</Button>
								<Button
									size="sm"
									variant="default"
									disabled={!apiKeyInput || isTesting}
									onClick={() => void handleTest()}
								>
									{isTesting ? "Testing…" : "Test"}
								</Button>
								<Button
									size="sm"
									variant="primary"
									disabled={!apiKeyInput || isTesting}
									onClick={() => void handleSaveKey()}
								>
									Save
								</Button>
							</div>
						</>
					) : (
						<div className={classes.rowActions}>
							<Button
								size="sm"
								variant="default"
								disabled={isTesting}
								onClick={() => void handleTest()}
							>
								{isTesting ? "Testing…" : "Test"}
							</Button>
						</div>
					)}
					{testResult && (
						<p
							className={classes.inlineNote}
							data-tone={testResult.success ? "ok" : "error"}
							role="status"
						>
							{testResult.message}
						</p>
					)}
				</div>
			)}
		</div>
	);
};

const IntegrationsTab = () => {
	const preferenceOrder = useSettings(
		(state) => state.metadataProviders.preferenceOrder,
	);
	const autoLookup = useSettings(
		(state) => state.metadataProviders.autoLookupOnImport,
	);
	const setAutoLookupOnImport = useSettings(
		(state) => state.setAutoLookupOnImport,
	);
	const anySourceEnabled = useAnySourceEnabled();
	const autoLookupSwitchId = useId();

	return (
		<div className={classes.groups}>
			<div>
				<h4 className={classes.groupTitle}>Metadata sources</h4>
				<p className={classes.paneNote}>
					Citadel looks up book details — titles, authors, and subjects — from
					these sources.
				</p>
				<div className={classes.group}>
					{preferenceOrder.map((id) => (
						<ProviderRow key={id} id={id} />
					))}
				</div>
			</div>
			<div>
				<div className={classes.group}>
					<SettingsRow
						label="Look up metadata when importing"
						htmlFor={autoLookupSwitchId}
						description={
							anySourceEnabled
								? "When an imported file has an ISBN, search your enabled sources automatically."
								: "Turn on a source above to enable automatic lookups."
						}
						control={
							<Switch
								id={autoLookupSwitchId}
								checked={autoLookup}
								disabled={!anySourceEnabled}
								onCheckedChange={(checked) =>
									void setAutoLookupOnImport(checked)
								}
							/>
						}
					/>
				</div>
			</div>
		</div>
	);
};
