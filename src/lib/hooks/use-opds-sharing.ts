import type {
	OpdsCredentialStatus,
	OpdsNetworkInterface,
	OpdsServiceStatus,
} from "@/bindings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SharingSettings } from "@/lib/platform/settings/types";
import { opdsClientForPlatform, tauriOpdsClient } from "@/lib/services/opds";

const POLL_INTERVAL_MS = 1_000;

interface OpdsSharingController {
	status: OpdsServiceStatus | null;
	interfaces: OpdsNetworkInterface[];
	credentials: OpdsCredentialStatus;
	isLoading: boolean;
	isActing: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	start: (settings: SharingSettings, password: string) => Promise<boolean>;
	stop: () => Promise<void>;
	generatePassword: (username: string) => Promise<string | null>;
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Backend status is authoritative. Every Settings window polls the same
 * desktop service, so actions in one window appear in the others without
 * treating local component state as server state. */
export const useOpdsSharing = (supported: boolean): OpdsSharingController => {
	const client = useMemo(
		() => opdsClientForPlatform(supported, tauriOpdsClient),
		[supported],
	);
	const [status, setStatus] = useState<OpdsServiceStatus | null>(null);
	const [interfaces, setInterfaces] = useState<OpdsNetworkInterface[]>([]);
	const [credentials, setCredentials] = useState<OpdsCredentialStatus>({
		configured: false,
		username: null,
	});
	const [isLoading, setIsLoading] = useState(supported);
	const [isActing, setIsActing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const refreshing = useRef(false);

	const refresh = useCallback(async () => {
		if (!client || refreshing.current) return;
		refreshing.current = true;
		try {
			const [nextStatus, nextInterfaces, nextCredentials] = await Promise.all([
				client.status(),
				client.listInterfaces(),
				client.credentialStatus(),
			]);
			setStatus(nextStatus);
			setInterfaces(nextInterfaces);
			setCredentials(nextCredentials);
			setError(null);
		} catch (cause) {
			setError(message(cause));
		} finally {
			refreshing.current = false;
			setIsLoading(false);
		}
	}, [client]);

	useEffect(() => {
		if (!client) {
			setIsLoading(false);
			return;
		}
		void refresh();
		const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
		const handleVisibility = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		document.addEventListener("visibilitychange", handleVisibility);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", handleVisibility);
		};
	}, [client, refresh]);

	const start = useCallback(
		async (settings: SharingSettings, password: string): Promise<boolean> => {
			if (!client) return false;
			setIsActing(true);
			setError(null);
			try {
				if (settings.authenticationEnabled) {
					if (password) {
						await client.configureCredentials({
							username: settings.username.trim(),
							password,
						});
					}
				}
				const nextStatus = await client.start({
					target: settings.target,
					port: settings.port,
					authenticationEnabled: settings.authenticationEnabled,
				});
				setStatus(nextStatus);
				setCredentials(await client.credentialStatus());
				return true;
			} catch (cause) {
				setError(message(cause));
				return false;
			} finally {
				setIsActing(false);
			}
		},
		[client],
	);

	const stop = useCallback(async () => {
		if (!client) return;
		setIsActing(true);
		setError(null);
		try {
			setStatus(await client.stop());
		} catch (cause) {
			setError(message(cause));
		} finally {
			setIsActing(false);
		}
	}, [client]);

	const generatePassword = useCallback(
		async (username: string): Promise<string | null> => {
			if (!client) return null;
			setIsActing(true);
			setError(null);
			try {
				const generated = await client.generateCredentials(username.trim());
				setCredentials({ configured: true, username: generated.username });
				return generated.password;
			} catch (cause) {
				setError(message(cause));
				return null;
			} finally {
				setIsActing(false);
			}
		},
		[client],
	);

	return {
		status,
		interfaces,
		credentials,
		isLoading,
		isActing,
		error,
		refresh,
		start,
		stop,
		generatePassword,
	};
};
