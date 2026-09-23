import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	OpdsCredentialSecret,
	OpdsCredentialStatus,
	OpdsErrorCode,
	OpdsServiceStatus,
	OpdsStartConfig,
} from "@/bindings";
import type { OpdsClient } from "@/lib/services/opds";
import { opdsClientForPlatform, tauriOpdsClient } from "@/lib/services/opds";

const POLL_INTERVAL_MS = 1_000;
/** Only surface the busy state when an action is actually slow. */
const ACTING_DELAY_MS = 200;

/** Which part of the pane an error belongs to, so it renders next to the
 * control that caused it. */
export const SHARING_ERROR_SOURCE = {
	server: "server",
	credentials: "credentials",
} as const;
export type SharingErrorSource =
	(typeof SHARING_ERROR_SOURCE)[keyof typeof SHARING_ERROR_SOURCE];

export interface SharingError {
	source: SharingErrorSource;
	/** Present when the service reported it; rejected commands carry none. */
	code: OpdsErrorCode | null;
	message: string;
}

export type SharingOutcome = { ok: true } | { ok: false; error: SharingError };

export type RunResult<TValue> =
	| { ok: true; value: TValue }
	| { ok: false; error: SharingError };

interface OpdsSharingController {
	status: OpdsServiceStatus | null;
	credentials: OpdsCredentialStatus;
	isLoading: boolean;
	isActing: boolean;
	/** A failed action's error, else the service's own failure reason. */
	error: SharingError | null;
	refresh: () => Promise<void>;
	credentialSecret: () => Promise<OpdsCredentialSecret | null>;
	start: (config: OpdsStartConfig) => Promise<SharingOutcome>;
	reconfigure: (config: OpdsStartConfig) => Promise<SharingOutcome>;
	stop: () => Promise<void>;
	configureCredentials: (credentials: {
		username: string;
		password: string;
	}) => Promise<boolean>;
	generateCredentials: (username: string) => Promise<string | null>;
	clearCredentials: () => Promise<void>;
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const noClient = (source: SharingErrorSource): RunResult<never> => ({
	ok: false,
	error: {
		source,
		code: null,
		message: "Sharing is not available on this platform.",
	},
});

/** The service's own failure (a failed bind, a listener that died). */
const serviceError = (status: OpdsServiceStatus): SharingError | null => {
	if (status.state !== "error") return null;
	return {
		source: SHARING_ERROR_SOURCE.server,
		code: status.error?.code ?? null,
		message: status.error?.message ?? "Sharing could not start.",
	};
};

/** Start and reconfigure report a failed bind as a status in the error
 * state, not as a rejected command; both count as failure. */
export const startOutcome = (
	result: RunResult<OpdsServiceStatus>,
): SharingOutcome => {
	if (!result.ok) return result;
	const error = serviceError(result.value);
	return error ? { ok: false, error } : { ok: true };
};

/** Backend status is authoritative: the pane renders what the service
 * reports, never local component state, so a restart elsewhere reads
 * correctly here too. */
export const useOpdsSharing = (supported: boolean): OpdsSharingController => {
	const client = useMemo(
		() => opdsClientForPlatform(supported, tauriOpdsClient),
		[supported],
	);
	const [status, setStatus] = useState<OpdsServiceStatus | null>(null);
	const [credentials, setCredentials] = useState<OpdsCredentialStatus>({
		configured: false,
		username: null,
	});
	const [isLoading, setIsLoading] = useState(supported);
	const [isActing, setIsActing] = useState(false);
	const [error, setError] = useState<SharingError | null>(null);
	const refreshing = useRef(false);
	/** A mutation is in flight: the poll must not publish interim states
	 * (Stopped/Starting) or the pane flaps. */
	const mutating = useRef(false);
	/** Bumped by every mutation; polls discard results from before the bump. */
	const mutationSeq = useRef(0);
	const actingTimer = useRef<number | null>(null);

	const beginActing = useCallback(() => {
		// Fast operations finish before this fires, so toggles and buttons
		// never flash their disabled styling mid-flight.
		if (actingTimer.current !== null) window.clearTimeout(actingTimer.current);
		actingTimer.current = window.setTimeout(() => {
			actingTimer.current = null;
			setIsActing(true);
		}, ACTING_DELAY_MS);
	}, []);
	const endActing = useCallback(() => {
		if (actingTimer.current !== null) {
			window.clearTimeout(actingTimer.current);
			actingTimer.current = null;
		}
		setIsActing(false);
	}, []);

	useEffect(
		() => () => {
			if (actingTimer.current !== null)
				window.clearTimeout(actingTimer.current);
		},
		[],
	);

	const credentialSecret =
		useCallback(async (): Promise<OpdsCredentialSecret | null> => {
			if (!client) return null;
			try {
				return await client.credentialSecret();
			} catch {
				return null;
			}
		}, [client]);

	const refresh = useCallback(async () => {
		if (!client || refreshing.current || mutating.current) return;
		refreshing.current = true;
		const seq = mutationSeq.current;
		try {
			const [nextStatus, nextCredentials] = await Promise.all([
				client.status(),
				client.credentialStatus(),
			]);
			// A mutation that landed while this poll was in flight publishes
			// its own fresh status; ours is stale by definition. Polls never
			// clear mutation errors — those belong to the action that set
			// them and outlive a single poll cycle.
			if (seq !== mutationSeq.current) return;
			setStatus(nextStatus);
			setCredentials(nextCredentials);
		} catch {
			// A failed poll says nothing new; the next one will recover.
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

	const run = useCallback(
		async <TValue>(
			source: SharingErrorSource,
			action: (client: OpdsClient) => Promise<TValue>,
		): Promise<RunResult<TValue>> => {
			if (!client) return noClient(source);
			mutating.current = true;
			mutationSeq.current += 1;
			beginActing();
			setError(null);
			try {
				const value = await action(client);
				setStatus(await client.status());
				setCredentials(await client.credentialStatus());
				return { ok: true, value };
			} catch (cause) {
				const failure = { source, code: null, message: message(cause) };
				setError(failure);
				return { ok: false, error: failure };
			} finally {
				mutating.current = false;
				endActing();
			}
		},
		[client, beginActing, endActing],
	);

	const start = useCallback(
		async (config: OpdsStartConfig): Promise<SharingOutcome> =>
			startOutcome(
				await run(SHARING_ERROR_SOURCE.server, (client) =>
					client.start(config),
				),
			),
		[run],
	);

	const reconfigure = useCallback(
		async (config: OpdsStartConfig): Promise<SharingOutcome> =>
			startOutcome(
				await run(SHARING_ERROR_SOURCE.server, (client) =>
					client.reconfigure(config),
				),
			),
		[run],
	);

	const stop = useCallback(async (): Promise<void> => {
		await run(SHARING_ERROR_SOURCE.server, (client) => client.stop());
	}, [run]);

	const configureCredentials = useCallback(
		async (credentials: {
			username: string;
			password: string;
		}): Promise<boolean> => {
			const result = await run(SHARING_ERROR_SOURCE.credentials, (client) =>
				client.configureCredentials(credentials),
			);
			return result.ok;
		},
		[run],
	);

	const clearCredentials = useCallback(async (): Promise<void> => {
		await run(SHARING_ERROR_SOURCE.credentials, (client) =>
			client.clearCredentials(),
		);
	}, [run]);

	const generateCredentials = useCallback(
		async (username: string): Promise<string | null> => {
			// Generate-and-set: the backend hot-swaps the live credential
			// snapshot, so a running share keeps running through rotation.
			const generated = await run(SHARING_ERROR_SOURCE.credentials, (client) =>
				client.generateCredentials(username.trim()),
			);
			return generated.ok ? generated.value.password : null;
		},
		[run],
	);

	return {
		status,
		credentials,
		isLoading,
		isActing,
		error: error ?? (status ? serviceError(status) : null),
		refresh,
		credentialSecret,
		start,
		reconfigure,
		stop,
		configureCredentials,
		generateCredentials,
		clearCredentials,
	};
};
