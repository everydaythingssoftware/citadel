import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * True while a navigation has been waiting on its route's data for longer
 * than `delayMs`. A fetch that finishes inside the delay shows nothing.
 */
export const useNavigationPending = (delayMs: number): boolean => {
	const loading = useRouterState({ select: (state) => state.isLoading });
	const [shown, setShown] = useState(false);

	useEffect(() => {
		if (!loading) {
			setShown(false);
			return;
		}
		const timer = setTimeout(() => setShown(true), delayMs);
		return () => clearTimeout(timer);
	}, [loading, delayMs]);

	return shown;
};
