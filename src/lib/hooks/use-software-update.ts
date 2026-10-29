import { useEffect, useMemo, useState } from "react";
import { usePlatform } from "@/lib/platform/context";
import {
	displayedStatus,
	MIN_ATTEMPT_FEEDBACK_MS,
	type SoftwareUpdateState,
	type UpdateAttempt,
} from "@/lib/updates/software-update";

export interface SoftwareUpdate {
	state: SoftwareUpdateState;
	check: () => void;
	later: () => void;
	updateNow: () => void;
}

/**
 * Citadel's update state, kept in step with the backend in every window.
 * Null where updates aren't supported, or until the state first arrives.
 */
export const useSoftwareUpdate = (): SoftwareUpdate | null => {
	const platform = usePlatform();
	const [state, setState] = useState<SoftwareUpdateState | null>(null);
	const [attempt, setAttempt] = useState<UpdateAttempt | null>(null);

	// Each press shows its busy state for a moment, however fast the answer.
	useEffect(() => {
		if (attempt === null) return;
		const timer = window.setTimeout(
			() => setAttempt(null),
			MIN_ATTEMPT_FEEDBACK_MS,
		);
		return () => window.clearTimeout(timer);
	}, [attempt]);

	useEffect(() => {
		if (!platform.capabilities.supportsAutoUpdates) return;
		let cancelled = false;
		let unlisten: (() => void) | undefined;

		// Listen before asking, and let a broadcast win over the snapshot, so
		// a change between the two can't be lost.
		void platform.updates
			.onChange((next) => {
				if (!cancelled) setState(next);
			})
			.then((stop) => {
				if (cancelled) stop();
				else unlisten = stop;
			});
		platform.updates
			.state()
			.then((snapshot) => {
				if (!cancelled) setState((current) => current ?? snapshot);
			})
			.catch((error: unknown) => console.error("Software update:", error));

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [platform]);

	const actions = useMemo(() => {
		// Failures land in the broadcast state; nothing else to do here.
		const run = (kind: UpdateAttempt, action: () => Promise<unknown>) => () => {
			setAttempt(kind);
			action().catch((error: unknown) =>
				console.error("Software update:", error),
			);
		};
		return {
			check: run("check", platform.updates.check),
			later: run("update", platform.updates.later),
			updateNow: run("update", platform.updates.updateNow),
		};
	}, [platform]);

	return state
		? {
				state: { ...state, status: displayedStatus(state.status, attempt) },
				...actions,
			}
		: null;
};
