import type { OpdsNetworkInterface } from "@/bindings";
import { describe, expect, it, vi } from "vitest";
import type { SharingSettings } from "@/lib/platform/settings/types";
import {
	passwordFreeSettings,
	selectedInterfaceUnavailable,
	sharingTargetOptions,
	targetFromValue,
	targetValue,
	validateSharing,
} from "@/lib/opds-sharing";
import type { OpdsClient } from "@/lib/services/opds";
import { opdsClientForPlatform } from "@/lib/services/opds";

const settings: SharingSettings = {
	target: { type: "allLocalNetworks" },
	port: 8080,
	authenticationEnabled: false,
	username: "",
};

const network = (
	id: string,
	state: "up" | "down" = "up",
): OpdsNetworkInterface => ({
	id,
	label: id === "en0" ? "Wi-Fi" : id,
	kind: "lan",
	state,
	addresses: state === "up" ? ["192.168.1.4"] : [],
	shareable: state === "up",
});

describe("OPDS sharing preferences", () => {
	it("validates ports and requires transient credentials only when needed", () => {
		expect(
			validateSharing({
				settings: { ...settings, port: 70_000 },
				password: "",
				credentialsConfigured: false,
				configuredUsername: null,
			}),
		).toEqual({ port: "Enter a port from 1 to 65535." });

		const protectedSettings = {
			...settings,
			authenticationEnabled: true,
			username: "reader",
		};
		expect(
			validateSharing({
				settings: protectedSettings,
				password: "",
				credentialsConfigured: false,
				configuredUsername: null,
			}),
		).toEqual({ password: "Set a password." });
		expect(
			validateSharing({
				settings: protectedSettings,
				password: "",
				credentialsConfigured: true,
				configuredUsername: "reader",
			}),
		).toEqual({});
	});

	it("round-trips interface targets and retains a missing selected interface", () => {
		const target = { type: "interface", id: "en9" } as const;
		expect(targetFromValue(targetValue(target))).toEqual(target);
		expect(sharingTargetOptions([network("en0")], target)).toContainEqual({
			value: "interface:en9",
			label: "en9 — unavailable",
		});
		expect(selectedInterfaceUnavailable([network("en0")], target)).toBe(true);
		expect(
			selectedInterfaceUnavailable([network("en0", "down")], {
				type: "interface",
				id: "en0",
			}),
		).toBe(true);
	});

	it("the persisted shape cannot contain a password or verifier", () => {
		const persisted = passwordFreeSettings({
			...settings,
			authenticationEnabled: true,
			username: " reader ",
		});
		expect(persisted).toEqual({
			...settings,
			authenticationEnabled: true,
			username: "reader",
		});
		expect(JSON.stringify(persisted)).not.toMatch(/password|verifier/i);
	});

	it("returns no backend client on web without touching the desktop delegate", () => {
		const status = vi.fn();
		const desktop = { status } as unknown as OpdsClient;
		expect(opdsClientForPlatform(false, desktop)).toBeNull();
		expect(status).not.toHaveBeenCalled();
	});
});
