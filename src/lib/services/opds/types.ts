import type {
	NewDeviceKey,
	OpdsDeviceKeys,
	OpdsServiceStatus,
	OpdsStartConfig,
} from "@/bindings";

export interface OpdsClient {
	status(): Promise<OpdsServiceStatus>;
	start(config: OpdsStartConfig): Promise<OpdsServiceStatus>;
	stop(): Promise<OpdsServiceStatus>;
	reconfigure(config: OpdsStartConfig): Promise<OpdsServiceStatus>;
	deviceKeys(): Promise<OpdsDeviceKeys>;
	createDeviceKey(name: string): Promise<NewDeviceKey>;
	rotateDeviceKey(keyId: string): Promise<NewDeviceKey>;
	revokeDeviceKey(keyId: string): Promise<OpdsDeviceKeys>;
	renameUser(username: string): Promise<OpdsDeviceKeys>;
}
