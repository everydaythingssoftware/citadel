import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";

/**
 * The history entry a page at `pathname` is showing. The router moves its
 * location as soon as a navigation starts, while the page stays up until
 * the next one can show; this keeps naming the entry the page belongs to.
 */
export const useShownEntryKey = (pathname: string): string => {
	const current = useRouterState({
		select: (state) =>
			state.location.pathname === pathname
				? (state.location.state.__TSR_key ?? state.location.href)
				: null,
	});
	const [shown, setShown] = useState(current ?? "");
	if (current !== null && current !== shown) setShown(current);
	return current ?? shown;
};
