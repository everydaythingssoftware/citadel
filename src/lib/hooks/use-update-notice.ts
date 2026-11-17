import { safeAsyncEventHandler } from "@/lib/async";
import { useSoftwareUpdate } from "@/lib/hooks/use-software-update";
import { none, type Option, some } from "@/lib/option";
import {
	updateNoticeTitle,
	updateNoticeVersion,
} from "@/lib/updates/update-notice";
import { useSettings } from "@/stores/settings/store";

export interface UpdateNotice {
	title: string;
	/** Installs and relaunches at once, without asking. */
	restart: () => void;
	hide: () => void;
}

/**
 * The sidebar footer's "Citadel 1.4 is ready / Restart to update" row,
 * once an update has downloaded; ignored, it installs when Citadel quits.
 */
export const useUpdateNotice = (): Option<UpdateNotice> => {
	const update = useSoftwareUpdate();
	const hiddenVersion = useSettings((s) => s.hiddenUpdateVersion);
	const setHiddenUpdateVersion = useSettings((s) => s.setHiddenUpdateVersion);
	const version = updateNoticeVersion(update?.state ?? null, hiddenVersion);
	if (!update || !version.isSome) return none();
	return some({
		title: updateNoticeTitle(version.value),
		restart: update.updateNow,
		hide: safeAsyncEventHandler(() => setHiddenUpdateVersion(version.value)),
	});
};
