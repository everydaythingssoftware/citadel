import {
	type SoftwareUpdateState as DesktopUpdateState,
	commands,
	events,
} from "@/bindings";
import type { SoftwareUpdateState } from "@/lib/updates/software-update";
import type { UpdatesAdapter } from "../types";

const unwrap = <TValue>(
	result: { status: "ok"; data: TValue } | { status: "error"; error: string },
): TValue => {
	if (result.status === "error") throw new Error(result.error);
	return result.data;
};

/** The desktop app checks, downloads and installs its own updates. */
export const fromDesktop = ({
	currentVersion,
	status,
	canInstallOnQuit,
}: DesktopUpdateState): SoftwareUpdateState => ({
	subject: "app",
	currentVersion,
	status,
	actions: { check: true, install: true, installOnQuit: canInstallOnQuit },
});

export const tauriUpdates: UpdatesAdapter = {
	state: async () => fromDesktop(await commands.clbQuerySoftwareUpdate()),
	onChange: (handler) =>
		events.softwareUpdateChanged.listen((event) =>
			handler(fromDesktop(event.payload)),
		),
	onShowRequested: (handler) =>
		events.showSoftwareUpdate.listen(() => handler()),
	check: async () => {
		unwrap(await commands.clbCmdCheckForUpdates());
	},
	later: async () => {
		unwrap(await commands.clbCmdUpdateLater());
	},
	updateNow: async () => unwrap(await commands.clbCmdUpdateNow()),
	showInSettings: () => commands.clbCmdOpenSoftwareUpdate(),
};
