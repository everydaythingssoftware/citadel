import { commands, events } from "@/bindings";
import type { UpdatesAdapter } from "../types";

const unwrap = <TValue>(
	result: { status: "ok"; data: TValue } | { status: "error"; error: string },
): TValue => {
	if (result.status === "error") throw new Error(result.error);
	return result.data;
};

export const tauriUpdates: UpdatesAdapter = {
	state: () => commands.clbQuerySoftwareUpdate(),
	onChange: (handler) =>
		events.softwareUpdateChanged.listen((event) => handler(event.payload)),
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
