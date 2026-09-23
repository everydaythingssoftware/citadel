import type {
	GeneratedOpdsCredentials,
	OpdsCredentialSecret,
	OpdsCredentialStatus,
	OpdsServiceStatus,
	OpdsStartConfig,
	OpdsStatusError,
	Result,
} from "@/bindings";
import { commands } from "@/bindings";

export interface OpdsCredentials {
	username: string;
	password: string;
}

export interface OpdsClient {
	status(): Promise<OpdsServiceStatus>;
	start(config: OpdsStartConfig): Promise<OpdsServiceStatus>;
	stop(): Promise<OpdsServiceStatus>;
	reconfigure(config: OpdsStartConfig): Promise<OpdsServiceStatus>;
	credentialStatus(): Promise<OpdsCredentialStatus>;
	credentialSecret(): Promise<OpdsCredentialSecret | null>;
	configureCredentials(
		credentials: OpdsCredentials,
	): Promise<OpdsCredentialStatus>;
	generateCredentials(username: string): Promise<GeneratedOpdsCredentials>;
	clearCredentials(): Promise<OpdsCredentialStatus>;
}

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
	credentialStatus: async () =>
		unwrap(await commands.clbQueryOpdsCredentialStatus()),
	credentialSecret: async () =>
		unwrap(await commands.clbQueryOpdsCredentialSecret()),
	configureCredentials: async ({ username, password }) =>
		unwrap(await commands.clbCmdConfigureOpdsCredentials(username, password)),
	generateCredentials: async (username) =>
		unwrap(await commands.clbCmdGenerateOpdsCredentials(username)),
	clearCredentials: async () =>
		unwrap(await commands.clbCmdClearOpdsCredentials()),
};

/** A web build gets no client at all, making accidental backend calls harder
 * than merely hiding or disabling a button. */
export const opdsClientForPlatform = (
	supported: boolean,
	desktopClient: OpdsClient = tauriOpdsClient,
): OpdsClient | null => (supported ? desktopClient : null);
