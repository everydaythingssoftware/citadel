import { useCallback, useEffect, useState } from "react";
import { onServerBuildChange } from "@/lib/updates/server-build";

export interface ServerUpdatedNotice {
	/** The server's new build, while the banner shows. */
	build: string | null;
	reload: () => void;
	dismiss: () => void;
}

/**
 * The browser's "Citadel was updated" banner: the server answered with a
 * different build than the one this page loaded from. One banner per build.
 */
export const useServerUpdatedNotice = (
	enabled: boolean,
): ServerUpdatedNotice => {
	const [build, setBuild] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) return;
		return onServerBuildChange(setBuild);
	}, [enabled]);

	const reload = useCallback(() => window.location.reload(), []);
	const dismiss = useCallback(() => setBuild(null), []);

	return { build, reload, dismiss };
};
