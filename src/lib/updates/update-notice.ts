import type { SoftwareUpdateState } from "./software-update";

const numericParts = (version: string): number[] =>
	(version.split(/[-+]/)[0] ?? "")
		.split(".")
		.map((part) => Number.parseInt(part, 10))
		.map((part) => (Number.isFinite(part) ? part : 0));

/**
 * Orders release versions by their numeric parts ("1.10" after "1.9"); a
 * prerelease sorts before its release. Negative, zero or positive.
 */
export const compareVersions = (a: string, b: string): number => {
	const left = numericParts(a);
	const right = numericParts(b);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	const leftPre = a.includes("-");
	const rightPre = b.includes("-");
	if (leftPre === rightPre) return 0;
	return leftPre ? -1 : 1;
};

/**
 * The version the sidebar's "Restart to Update" row offers: an app update
 * that has finished downloading and waits for quit. Installs that can't
 * install at quit (Linux packages, which need a password) never get here.
 * Hiding the row holds until a newer version is ready.
 */
export const updateNoticeVersion = (
	state: SoftwareUpdateState | null,
	hiddenVersion: string | null,
): string | null => {
	if (state?.subject !== "app") return null;
	if (state.status.kind !== "ready" || !state.actions.installOnQuit) {
		return null;
	}
	const { version } = state.status;
	if (hiddenVersion !== null && compareVersions(version, hiddenVersion) <= 0) {
		return null;
	}
	return version;
};

/**
 * An update the background check found, to download now so it can install
 * at quit; once per version, so a failed download isn't retried in a loop.
 */
export const backgroundDownloadVersion = (
	state: SoftwareUpdateState | null,
	{
		automaticChecks,
		alreadyRequested,
	}: { automaticChecks: boolean; alreadyRequested: string | null },
): string | null => {
	if (!automaticChecks || !state || state.subject !== "app") return null;
	if (state.status.kind !== "available" || !state.actions.installOnQuit) {
		return null;
	}
	return state.status.version === alreadyRequested
		? null
		: state.status.version;
};

/** "1.4.0" reads as "1.4"; any other version stays as it is. */
export const displayVersion = (version: string): string =>
	version.replace(/^(\d+\.\d+)\.0$/, "$1");

export const updateNoticeTitle = (version: string): string =>
	`Citadel ${displayVersion(version)} is ready`;
