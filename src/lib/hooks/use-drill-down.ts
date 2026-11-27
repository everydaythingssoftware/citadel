import {
	useCanGoBack,
	useNavigate,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { drillSourcePath, type TDrillSource } from "@/lib/drill-down";

/** The row last drilled into, and the list entry it was drilled from. */
let lastDrill: {
	source: TDrillSource;
	rowId: string;
	entryKey: string;
} | null = null;

const useEntryKey = () =>
	useRouterState({
		select: (state) => state.location.state.__TSR_key ?? state.location.href,
	});

/**
 * A list page's side of a drill-down: `noteDrill` as a row opens its
 * books, and, coming Back to that same entry, the row it opened
 * (`returnedRowId`), which the list shows as current.
 */
export const useDrillDownList = (source: TDrillSource) => {
	const entryKey = useEntryKey();
	const [returnedRowId] = useState(() =>
		lastDrill !== null &&
		lastDrill.source === source &&
		lastDrill.entryKey === entryKey
			? lastDrill.rowId
			: null,
	);
	const noteDrill = useCallback(
		(rowId: string | number) => {
			lastDrill = { source, rowId: String(rowId), entryKey };
		},
		[source, entryKey],
	);
	return { returnedRowId, noteDrill };
};

/**
 * Back from a drilled-down books view to its list, as the Back gesture
 * would, so the list comes back as it was left (scroll and row). Opened
 * with nothing behind it (a direct link), it opens the list instead,
 * replacing this entry.
 */
export const useDrillBack = (
	source: TDrillSource | undefined,
): (() => void) | undefined => {
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const navigate = useNavigate();
	const back = useCallback(() => {
		if (source === undefined) return;
		if (canGoBack) router.history.back();
		else void navigate({ to: drillSourcePath(source), replace: true });
	}, [source, canGoBack, router, navigate]);
	return source === undefined ? undefined : back;
};
