import { useCallback, useEffect, useState } from "react";
import type { DatabaseProblem, RecoveryStep } from "@/bindings";
import { NO_UPDATE_MESSAGE } from "@/lib/database-recovery/copy";
import { usePlatform } from "@/lib/platform/context";

export interface DatabaseRecovery {
	/** The step running now; the app restarts when it succeeds. */
	running: RecoveryStep | null;
	error: string | null;
	recover: (step: RecoveryStep) => void;
}

export const useDatabaseRecovery = (
	problem: DatabaseProblem,
): DatabaseRecovery => {
	const platform = usePlatform();
	const [running, setRunning] = useState<RecoveryStep | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Settings never load in this state, so nothing else shows the window.
	// The technical reason goes to the log rather than the screen.
	useEffect(() => {
		console.error("citadel.db:", problem.details);
		void platform.window.show();
	}, [platform, problem.details]);

	const recover = useCallback(
		(step: RecoveryStep) => {
			setRunning(step);
			setError(null);
			const run =
				step === "update"
					? platform.updates.updateNow().then((outcome) => {
							// A successful install restarts the app.
							if (outcome === "noUpdate") throw new Error(NO_UPDATE_MESSAGE);
						})
					: platform.recovery.recover(step);
			run.catch((cause: unknown) => {
				setRunning(null);
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		},
		[platform],
	);

	return { running, error, recover };
};
