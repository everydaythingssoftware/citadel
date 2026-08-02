import type { OpdsNetworkInterface, OpdsServiceStatus } from "@/bindings";
import type {
	SharingSettings,
	SharingTarget,
} from "@/lib/platform/settings/types";

export const ALL_NETWORKS_VALUE = "allLocalNetworks";
const INTERFACE_PREFIX = "interface:";

export interface SharingValidationInput {
	settings: SharingSettings;
	password: string;
	credentialsConfigured: boolean;
	configuredUsername: string | null;
}

export interface SharingValidation {
	port?: string;
	username?: string;
	password?: string;
}

export const validateSharing = ({
	settings,
	password,
	credentialsConfigured,
	configuredUsername,
}: SharingValidationInput): SharingValidation => {
	const errors: SharingValidation = {};
	if (
		!Number.isInteger(settings.port) ||
		settings.port < 1 ||
		settings.port > 65_535
	) {
		errors.port = "Enter a port from 1 to 65535.";
	}
	if (settings.authenticationEnabled) {
		const username = settings.username.trim();
		if (!username) errors.username = "Enter a username.";
		const canReuseConfiguredPassword =
			credentialsConfigured && configuredUsername === username;
		if (!password && !canReuseConfiguredPassword) {
			errors.password = "Set a password.";
		}
	}
	return errors;
};

export const hasValidationErrors = (errors: SharingValidation): boolean =>
	Object.values(errors).some(Boolean);

export const targetValue = (target: SharingTarget): string =>
	target.type === "allLocalNetworks"
		? ALL_NETWORKS_VALUE
		: `${INTERFACE_PREFIX}${target.id}`;

export const targetFromValue = (value: string): SharingTarget =>
	value === ALL_NETWORKS_VALUE
		? { type: "allLocalNetworks" }
		: { type: "interface", id: value.slice(INTERFACE_PREFIX.length) };

export interface SharingTargetOption {
	value: string;
	label: string;
}

export const sharingTargetOptions = (
	interfaces: OpdsNetworkInterface[],
	selected: SharingTarget,
): SharingTargetOption[] => {
	const options: SharingTargetOption[] = [
		{ value: ALL_NETWORKS_VALUE, label: "All local networks" },
		...interfaces
			.filter((network) => network.kind !== "loopback")
			.map((network) => ({
				value: `${INTERFACE_PREFIX}${network.id}`,
				label: `${network.label} (${network.id})${
					network.state === "down" || !network.shareable ? " — unavailable" : ""
				}`,
			})),
	];
	if (
		selected.type === "interface" &&
		!interfaces.some((network) => network.id === selected.id)
	) {
		options.push({
			value: `${INTERFACE_PREFIX}${selected.id}`,
			label: `${selected.id} — unavailable`,
		});
	}
	return options;
};

export const selectedInterfaceUnavailable = (
	interfaces: OpdsNetworkInterface[],
	target: SharingTarget,
): boolean => {
	if (target.type === "allLocalNetworks") return false;
	const selected = interfaces.find((network) => network.id === target.id);
	return !selected || selected.state === "down" || !selected.shareable;
};

export const isOperationalStatus = (
	status: OpdsServiceStatus | null,
): boolean => status !== null && status.state !== "stopped";

export const passwordFreeSettings = (
	settings: SharingSettings,
): SharingSettings => ({
	...settings,
	username: settings.username.trim(),
});
