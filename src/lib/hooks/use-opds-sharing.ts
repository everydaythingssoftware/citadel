import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	NewDeviceKey,
	OpdsDeviceKeys,
	OpdsErrorCode,
	OpdsServiceStatus,
	OpdsStartConfig,
} from "@/bindings";
import type { OpdsClient } from "@/lib/services/opds";
import { opdsClientForPlatform } from "@/lib/services/opds";

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
	/** The local user's OPDS username and device keys; null until loaded. */
	deviceKeys: OpdsDeviceKeys | null;
	isLoading: boolean;
	isActing: boolean;
	/** A failed action's error, else the service's own failure reason. */
	error: SharingError | null;
	refresh: () => Promise<void>;
	clearError: () => void;
	start: (config: OpdsStartConfig) => Promise<SharingOutcome>;
	reconfigure: (config: OpdsStartConfig) => Promise<SharingOutcome>;
	stop: () => Promise<void>;
	/** Each returns the new key's secret, shown once; null on failure. */
	createDeviceKey: (name: string) => Promise<NewDeviceKey | null>;
	rotateDeviceKey: (keyId: string) => Promise<NewDeviceKey | null>;
	revokeDeviceKey: (keyId: string) => Promise<boolean>;
	renameUser: (username: string) => Promise<boolean>;
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

/** The newest status the service announced, and how many it has sent. */
export interface Announced {
	status: OpdsServiceStatus | null;
	count: number;
}

/** Each announcement is sent after its change, in order, so one that arrived
 * while a status read was in flight is at least as new as the read's answer. */
export const newestStatus = (
	read: OpdsServiceStatus,
	countBeforeRead: number,
	announced: Announced,
): OpdsServiceStatus =>
	announced.count !== countBeforeRead && announced.status
		? announced.status
		: read;

/** Backend status is authoritative: the pane renders what the service
 * reports, never local component state, so a restart elsewhere reads
 * correctly here too. */
export const useOpdsSharing = (supported: boolean): OpdsSharingController => {
	const client = useMemo(() => opdsClientForPlatform(supported), [supported]);
	const [status, setStatus] = useState<OpdsServiceStatus | null>(null);
	const [deviceKeys, setDeviceKeys] = useState<OpdsDeviceKeys | null>(null);
	const [isLoading, setIsLoading] = useState(supported);
	const [isActing, setIsActing] = useState(false);
	const [error, setError] = useState<SharingError | null>(null);
	const refreshing = useRef(false);
	/** A mutation is in flight: status changes must not publish its interim
	 * states (Stopped/Starting) or the pane flaps; it publishes its own. */
	const mutating = useRef(false);
	/** Bumped by every mutation; a load discards results from before the bump. */
	const mutationSeq = useRef(0);
	const announced = useRef<Announced>({ status: null, count: 0 });
	const newestOf = useCallback(
		(read: OpdsServiceStatus, countBeforeRead: number) =>
			newestStatus(read, countBeforeRead, announced.current),
		[],
	);
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

	const clearError = useCallback(() => setError(null), []);

	const refresh = useCallback(async () => {
		if (!client || refreshing.current || mutating.current) return;
		refreshing.current = true;
		const seq = mutationSeq.current;
		const countBeforeRead = announced.current.count;
		try {
			const [nextStatus, nextKeys] = await Promise.all([
				client.status(),
				client.deviceKeys(),
			]);
			// A mutation that landed while this load was in flight publishes
			// its own fresh status; ours is stale by definition. Loads never
			// clear mutation errors — those belong to the action that set
			// them.
			if (seq !== mutationSeq.current) return;
			setStatus(newestOf(nextStatus, countBeforeRead));
			setDeviceKeys(nextKeys);
		} catch {
			// A failed load says nothing new; the next status change recovers.
		} finally {
			refreshing.current = false;
			setIsLoading(false);
		}
	}, [client, newestOf]);

	useEffect(() => {
		if (!client) {
			setIsLoading(false);
			return;
		}
		// The service announces every change, including a listener that dies
		// on its own, so the pane needs no timer. Listening starts before the
		// first load, so no change falls between them.
		let stopListening: (() => void) | null = null;
		let unmounted = false;
		void client
			.onStatusChange((next) => {
				announced.current = {
					status: next,
					count: announced.current.count + 1,
				};
				if (!mutating.current) setStatus(next);
			})
			.then(
				(unlisten) => {
					if (unmounted) unlisten();
					else stopListening = unlisten;
				},
				() => {},
			)
			.then(() => {
				if (!unmounted) void refresh();
			});
		return () => {
			unmounted = true;
			stopListening?.();
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
				const countBeforeRead = announced.current.count;
				const read = await client.status();
				setDeviceKeys(await client.deviceKeys());
				setStatus(newestOf(read, countBeforeRead));
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
		[client, beginActing, endActing, newestOf],
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

	// Key changes hot-swap the live snapshot, so a running share keeps
	// running; revoking the last key stops one that requires sign-in.
	const createDeviceKey = useCallback(
		async (name: string): Promise<NewDeviceKey | null> => {
			const created = await run(SHARING_ERROR_SOURCE.credentials, (client) =>
				client.createDeviceKey(name.trim()),
			);
			return created.ok ? created.value : null;
		},
		[run],
	);

	const rotateDeviceKey = useCallback(
		async (keyId: string): Promise<NewDeviceKey | null> => {
			const rotated = await run(SHARING_ERROR_SOURCE.credentials, (client) =>
				client.rotateDeviceKey(keyId),
			);
			return rotated.ok ? rotated.value : null;
		},
		[run],
	);

	const revokeDeviceKey = useCallback(
		async (keyId: string): Promise<boolean> =>
			(
				await run(SHARING_ERROR_SOURCE.credentials, (client) =>
					client.revokeDeviceKey(keyId),
				)
			).ok,
		[run],
	);

	const renameUser = useCallback(
		async (username: string): Promise<boolean> =>
			(
				await run(SHARING_ERROR_SOURCE.credentials, (client) =>
					client.renameUser(username.trim()),
				)
			).ok,
		[run],
	);

	return {
		status,
		deviceKeys,
		isLoading,
		isActing,
		error: error ?? (status ? serviceError(status) : null),
		refresh,
		clearError,
		start,
		reconfigure,
		stop,
		createDeviceKey,
		rotateDeviceKey,
		revokeDeviceKey,
		renameUser,
	};
};
