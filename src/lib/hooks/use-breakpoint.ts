import { useCallback, useSyncExternalStore } from "react";

// Mantine's default breakpoint scale, which this app never overrode.
const BREAKPOINTS: Record<string, string> = {
	xs: "36em",
	sm: "48em",
	md: "62em",
	lg: "75em",
	xl: "88em",
};

export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const mql = window.matchMedia(query);
			mql.addEventListener("change", onChange);
			return () => {
				mql.removeEventListener("change", onChange);
			};
		},
		[query],
	);
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(query).matches,
	);
}

export function useBreakpoint(minBreakpoint = "sm", exact = false) {
	let query: string;
	if (exact) {
		// Exact breakpoint: min-width of this breakpoint and max-width of the next one (if it exists)
		const nextBreakpointIndex =
			Object.keys(BREAKPOINTS).indexOf(minBreakpoint) + 1;
		const nextBreakpointKey = Object.keys(BREAKPOINTS)[nextBreakpointIndex];
		const maxQuery = nextBreakpointKey
			? ` and (max-width: calc(${BREAKPOINTS[nextBreakpointKey]} - 1px))`
			: "";
		query = `(min-width: ${BREAKPOINTS[minBreakpoint]})${maxQuery}`;
	} else {
		// Min-width query for "minBreakpoint or larger"
		query = `(min-width: ${BREAKPOINTS[minBreakpoint]})`;
	}

	return useMediaQuery(query);
}
