import type { OpdsStatusError, Result } from "@/bindings";
import { commands } from "@/bindings";
import type { OpdsClient } from "./types";

const unwrap = <T>(result: Result<T, OpdsStatusError>): T => {
	if (result.status === "error") {
		throw new Error(result.error.message);
	}
	return result.data;
};

export const tauriOpdsClient: OpdsClient = {
	status: async () => unwrap(await commands.clbQueryOpdsStatus()),
	start: async (config) => unwrap(await commands.clbCmdStartOpds(config)),
	stop: async () => unwrap(await commands.clbCmdStopOpds()),
	reconfigure: async (config) =>
		unwrap(await commands.clbCmdReconfigureOpds(config)),
	deviceKeys: async () => unwrap(await commands.clbQueryOpdsDeviceKeys()),
	createDeviceKey: async (name) =>
		unwrap(await commands.clbCmdCreateOpdsDeviceKey(name)),
	rotateDeviceKey: async (keyId) =>
		unwrap(await commands.clbCmdRotateOpdsDeviceKey(keyId)),
	revokeDeviceKey: async (keyId) =>
		unwrap(await commands.clbCmdRevokeOpdsDeviceKey(keyId)),
	renameUser: async (username) =>
		unwrap(await commands.clbCmdRenameOpdsUser(username)),
};
