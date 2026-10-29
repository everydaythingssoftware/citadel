import type { Meta, StoryObj } from "@storybook/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	SoftwareUpdateState,
	SoftwareUpdateStatus,
} from "@/lib/updates/software-update";
import { SoftwareUpdateRow } from "./SoftwareUpdateRow";

const state = (
	status: SoftwareUpdateStatus,
	overrides: Partial<SoftwareUpdateState> = {},
): SoftwareUpdateState => ({
	currentVersion: "0.7.1",
	canInstallOnQuit: true,
	status,
	...overrides,
});

// Same card as a settings group (SettingsPanes.module.css .group).
const groupStyle = {
	width: 520,
	alignSelf: "start",
	border: "1px solid var(--ctd-border)",
	borderRadius: "0.5rem",
	backgroundColor: "var(--ctd-surface)",
} as const;

const handlers = {
	onCheck: () => {},
	onUpdateNow: () => {},
	onLater: () => {},
	onRestartNow: () => {},
};

const meta = {
	component: SoftwareUpdateRow,
	args: { state: state({ kind: "idle" }), ...handlers },
	render: (args) => (
		<div style={groupStyle}>
			<SoftwareUpdateRow {...args} />
		</div>
	),
} satisfies Meta<typeof SoftwareUpdateRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotYetChecked: Story = {};

export const Checking: Story = {
	args: { state: state({ kind: "checking" }) },
};

export const UpToDate: Story = {
	args: { state: state({ kind: "upToDate" }) },
};

export const Available: Story = {
	args: { state: state({ kind: "available", version: "0.7.2" }) },
};

/** .deb/.rpm installs: no Later, since installing needs a password prompt. */
export const AvailablePackageInstall: Story = {
	args: {
		state: state(
			{ kind: "available", version: "0.7.2" },
			{ canInstallOnQuit: false },
		),
	},
};

export const Downloading: Story = {
	args: {
		state: state({ kind: "downloading", version: "0.7.2", progress: 0.42 }),
	},
};

/** The server didn't send a size, so progress is indeterminate. */
export const DownloadingUnknownSize: Story = {
	args: {
		state: state({ kind: "downloading", version: "0.7.2", progress: null }),
	},
};

export const InstallsOnQuit: Story = {
	args: { state: state({ kind: "ready", version: "0.7.2" }) },
};

export const CheckFailed: Story = {
	args: {
		state: state({
			kind: "checkFailed",
			message: "Could not fetch a valid release JSON from the remote",
		}),
	},
};

export const UpdateFailed: Story = {
	args: {
		state: state({
			kind: "updateFailed",
			version: "0.7.2",
			message: "Failed to download update: connection reset",
		}),
	},
};

const ALL_STATES: [string, SoftwareUpdateState][] = [
	["Not yet checked", state({ kind: "idle" })],
	["Checking", state({ kind: "checking" })],
	["Up to date", state({ kind: "upToDate" })],
	["Available", state({ kind: "available", version: "0.7.2" })],
	[
		"Available (.deb/.rpm)",
		state({ kind: "available", version: "0.7.2" }, { canInstallOnQuit: false }),
	],
	[
		"Downloading",
		state({ kind: "downloading", version: "0.7.2", progress: 0.42 }),
	],
	["Installs on quit", state({ kind: "ready", version: "0.7.2" })],
	["Check failed", state({ kind: "checkFailed", message: "Offline" })],
	[
		"Update failed",
		state({ kind: "updateFailed", version: "0.7.2", message: "Offline" }),
	],
];

/** Every state stacked, for comparing them at a glance. */
export const AllStates: Story = {
	render: () => (
		<div style={{ display: "grid", gap: 14, alignContent: "start" }}>
			{ALL_STATES.map(([title, rowState]) => (
				<div key={title} style={{ display: "grid", gap: 4 }}>
					<span style={{ fontSize: 11, color: "var(--ctd-ink-soft)" }}>
						{title}
					</span>
					<div style={groupStyle}>
						<SoftwareUpdateRow state={rowState} {...handlers} />
					</div>
				</div>
			))}
		</div>
	),
};

type CheckOutcome = "updateAvailable" | "upToDate" | "checkFails";

interface WalkthroughProps {
	checkFinds: CheckOutcome;
	packageInstall: boolean;
}

/**
 * Stands in for the desktop updater: the row's buttons drive it, and it
 * moves through the same states the real one broadcasts.
 */
const useSimulatedUpdater = ({
	checkFinds,
	packageInstall,
}: WalkthroughProps) => {
	const initial = useCallback(
		() => state({ kind: "idle" }, { canInstallOnQuit: !packageInstall }),
		[packageInstall],
	);
	const [current, setCurrent] = useState(initial);
	const timers = useRef<number[]>([]);

	const clearTimers = useCallback(() => {
		for (const id of timers.current) window.clearTimeout(id);
		timers.current = [];
	}, []);
	const after = (ms: number, run: () => void) => {
		timers.current.push(window.setTimeout(run, ms));
	};
	const setStatus = (status: SoftwareUpdateStatus) =>
		setCurrent((previous) => ({ ...previous, status }));

	// Start over whenever the controls change.
	useEffect(() => {
		clearTimers();
		setCurrent(initial());
		return clearTimers;
	}, [initial, clearTimers]);

	const relaunchUpdated = () =>
		after(700, () =>
			setCurrent((previous) => ({
				...previous,
				currentVersion: "0.7.2",
				status: { kind: "upToDate" },
			})),
		);

	const download = (onDone: () => void) => {
		const step = (progress: number) => {
			setStatus({ kind: "downloading", version: "0.7.2", progress });
			if (progress >= 1) after(250, onDone);
			else after(120, () => step(Math.min(progress + 0.05, 1)));
		};
		step(0);
	};

	return {
		state: current,
		onCheck: () => {
			clearTimers();
			setStatus({ kind: "checking" });
			after(1200, () => {
				if (checkFinds === "updateAvailable") {
					setStatus({ kind: "available", version: "0.7.2" });
				} else if (checkFinds === "upToDate") {
					setStatus({ kind: "upToDate" });
				} else {
					setStatus({
						kind: "checkFailed",
						message: "Could not fetch a valid release JSON from the remote",
					});
				}
			});
		},
		onLater: () =>
			download(() => setStatus({ kind: "ready", version: "0.7.2" })),
		onUpdateNow: () => download(relaunchUpdated),
		onRestartNow: relaunchUpdated,
	};
};

const WalkthroughRow = (props: WalkthroughProps) => {
	const updater = useSimulatedUpdater(props);
	return (
		<div style={groupStyle}>
			<SoftwareUpdateRow {...updater} />
		</div>
	);
};

/**
 * Click through the flow. "Update Now" and "Restart Now" end with a pretend
 * relaunch onto 0.7.2; "Later" downloads and waits for quit.
 */
export const Walkthrough: StoryObj<WalkthroughProps> = {
	args: { checkFinds: "updateAvailable", packageInstall: false },
	argTypes: {
		checkFinds: {
			control: "inline-radio",
			options: ["updateAvailable", "upToDate", "checkFails"],
		},
		packageInstall: {
			name: "installed from .deb/.rpm",
			control: "boolean",
		},
	},
	parameters: { controls: { include: ["checkFinds", "packageInstall"] } },
	render: (args) => <WalkthroughRow {...args} />,
};
