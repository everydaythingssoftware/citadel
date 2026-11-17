import { none, type Option, some } from "@/lib/option";
import type { SoftwareUpdateState } from "./software-update";

/**
 * The version the sidebar's "Restart to update" row offers: an app update
 * that has finished downloading and waits for quit. Installs that can't
 * install at quit (Linux packages, which need a password) never get here.
 * Hiding the row holds until another version is ready.
 */
export const updateNoticeVersion = (
	state: SoftwareUpdateState | null,
	hiddenVersion: string | null,
): Option<string> => {
	if (state?.subject !== "app") return none();
	if (state.status.kind !== "ready" || !state.actions.installOnQuit) {
		return none();
	}
	const { version } = state.status;
	return version === hiddenVersion ? none() : some(version);
};

/** "1.4.0" reads as "1.4"; any other version stays as it is. */
export const displayVersion = (version: string): string =>
	version.replace(/^(\d+\.\d+)\.0$/, "$1");

export const updateNoticeTitle = (version: string): string =>
	`Citadel ${displayVersion(version)} is ready`;
