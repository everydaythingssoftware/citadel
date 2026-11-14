import { useEffect, useRef } from "react";
import { IS_DEV } from "@/lib/env";
import type { SoftwareUpdate } from "@/lib/hooks/use-software-update";
import {
	backgroundDownloadVersion,
	updateNoticeTitle,
	updateNoticeVersion,
} from "@/lib/updates/update-notice";
import { useSettings } from "@/stores/settings/store";
import { useSidebar } from "@/stores/sidebar/store";

export interface UpdateNotice {
	version: string;
	title: string;
	/** Installs and relaunches at once, without asking. */
	restart: () => void;
	/** "Hide Until Next Update". */
	hide: () => void;
}

/**
 * The sidebar footer's "Citadel 1.4 is ready / Restart to Update" row. An
 * update the automatic check finds downloads in the background, so the row
 * appears only once there is nothing left to wait for; ignored, it installs
 * when Citadel quits.
 */
export const useUpdateNotice = (
	update: SoftwareUpdate | null,
): UpdateNotice | null => {
	const hiddenVersion = useSidebar((s) => s.hiddenUpdateVersion);
	const hideUpdateUntilNext = useSidebar((s) => s.hideUpdateUntilNext);
	const automaticChecks = useSettings((s) => s.autoUpdateCheckingEnabled);
	const requested = useRef<string | null>(null);
	const state = update?.state ?? null;
	const later = update?.later;

	useEffect(() => {
		if (IS_DEV || !later) return;
		const version = backgroundDownloadVersion(state, {
			automaticChecks,
			alreadyRequested: requested.current,
		});
		if (version === null) return;
		requested.current = version;
		later();
	}, [state, automaticChecks, later]);

	const version = updateNoticeVersion(state, hiddenVersion);
	if (!update || version === null) return null;
	return {
		version,
		title: updateNoticeTitle(version),
		restart: update.updateNow,
		hide: () => hideUpdateUntilNext(version),
	};
};
