import { useEffect, useState } from "react";
import {
	type SignInLimits,
	serverService,
	signInLimitsSummary,
} from "@/lib/services/server";

export interface SignInLimitsState {
	/** What the limits are doing, in words; null until the counts load. */
	summary: string | null;
	error: string | null;
}

/** How the server is holding back wrong sign-ins; administrators only. */
export const useSignInLimits = (): SignInLimitsState => {
	const [limits, setLimits] = useState<SignInLimits | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		serverService
			.signInLimits()
			.then((loaded) => {
				if (!cancelled) setLimits(loaded);
			})
			.catch((failure: unknown) => {
				if (!cancelled)
					setError(
						failure instanceof Error ? failure.message : String(failure),
					);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { summary: limits ? signInLimitsSummary(limits) : null, error };
};
