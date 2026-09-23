import { useEffect, useState } from "react";
import { commands, type LibraryStats } from "@/bindings";

export type LibraryStatsState =
	| { status: "loading" }
	| { status: "error" }
	| { status: "loaded"; stats: LibraryStats };

const statsCache = new Map<string, LibraryStats>();

/**
 * Read-only peek at a Calibre library's headline counts (clbQueryLibraryStats),
 * safe to call for any library path, active or not. Successful results are
 * cached per path for the session; failures aren't cached, so a later mount
 * retries. Pass `enabled: false` to skip fetching entirely (a caller
 * supplying its own stats value, e.g. a story).
 */
export const useLibraryStats = (
	libraryRoot: string | null,
	enabled = true,
): LibraryStatsState => {
	const [state, setState] = useState<LibraryStatsState>(() => {
		const cached =
			enabled && libraryRoot !== null ? statsCache.get(libraryRoot) : undefined;
		return cached !== undefined
			? { status: "loaded", stats: cached }
			: { status: "loading" };
	});

	useEffect(() => {
		if (!enabled || libraryRoot === null) return;
		const cached = statsCache.get(libraryRoot);
		if (cached !== undefined) {
			setState({ status: "loaded", stats: cached });
			return;
		}
		let alive = true;
		setState({ status: "loading" });
		commands
			.clbQueryLibraryStats(libraryRoot)
			.then((result) => {
				if (!alive) return;
				if (result.status === "ok") {
					statsCache.set(libraryRoot, result.data);
					setState({ status: "loaded", stats: result.data });
				} else {
					setState({ status: "error" });
				}
			})
			.catch(() => {
				if (alive) setState({ status: "error" });
			});
		return () => {
			alive = false;
		};
	}, [enabled, libraryRoot]);

	return state;
};
