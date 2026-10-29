import type { SoftwareUpdateState, SoftwareUpdateStatus } from "@/bindings";

/**
 * The desktop backend owns this state and broadcasts it to every window
 * (CDL-51), so the gear badge and the Settings row always agree.
 */
export type { SoftwareUpdateState, SoftwareUpdateStatus };

/** The version a pending update offers, if there is one to badge. */
export const pendingUpdateVersion = (
	status: SoftwareUpdateStatus,
): string | null => {
	switch (status.kind) {
		case "available":
		case "downloading":
		case "ready":
		case "updateFailed":
			return status.version;
		default:
			return null;
	}
};

export type SoftwareUpdateControl =
	| { kind: "check"; checking: boolean }
	| { kind: "later" }
	| { kind: "updateNow" }
	| { kind: "progress"; version: string; value: number | null }
	| { kind: "restartNow" }
	| { kind: "retryCheck" }
	| { kind: "retryUpdate" };

export interface SoftwareUpdateRowView {
	label: string;
	/** Error text, shown on hover rather than taking up space. */
	detail?: string;
	controls: SoftwareUpdateControl[];
}

/** What Settings → Software Update shows for a state. */
export const softwareUpdateRowView = ({
	currentVersion,
	status,
	canInstallOnQuit,
}: SoftwareUpdateState): SoftwareUpdateRowView => {
	switch (status.kind) {
		case "idle":
			return {
				label: `Citadel ${currentVersion}`,
				controls: [{ kind: "check", checking: false }],
			};
		case "checking":
			return {
				label: `Citadel ${currentVersion}`,
				controls: [{ kind: "check", checking: true }],
			};
		case "upToDate":
			return {
				label: `Citadel ${currentVersion} is up to date`,
				controls: [{ kind: "check", checking: false }],
			};
		case "available":
			return {
				label: `Update available: ${status.version}`,
				controls: canInstallOnQuit
					? [{ kind: "later" }, { kind: "updateNow" }]
					: [{ kind: "updateNow" }],
			};
		case "downloading":
			return {
				label: `Update available: ${status.version}`,
				controls: [
					{ kind: "progress", version: status.version, value: status.progress },
				],
			};
		case "ready":
			return {
				label: `${status.version} installs when you quit`,
				controls: [{ kind: "restartNow" }],
			};
		case "checkFailed":
			return {
				label: "Couldn't check for updates",
				detail: status.message,
				controls: [{ kind: "retryCheck" }],
			};
		case "updateFailed":
			return {
				label: `Couldn't install ${status.version}`,
				detail: status.message,
				controls: [{ kind: "retryUpdate" }],
			};
	}
};

/** A Software Update button press whose busy state is still on screen. */
export type UpdateAttempt = "check" | "update";

/** Shortest time a press shows its busy state, however fast the answer. */
export const MIN_ATTEMPT_FEEDBACK_MS = 400;

/**
 * The status to show while a press's busy state is held: an instant answer
 * (offline, say) would otherwise leave the row looking untouched. Progress
 * the backend actually reports always shows through.
 */
export const displayedStatus = (
	actual: SoftwareUpdateStatus,
	attempt: UpdateAttempt | null,
): SoftwareUpdateStatus => {
	if (attempt === null) return actual;
	if (actual.kind === "checking" || actual.kind === "downloading") {
		return actual;
	}
	if (attempt === "check") return { kind: "checking" };
	if (actual.kind === "available" || actual.kind === "updateFailed") {
		return { kind: "downloading", version: actual.version, progress: null };
	}
	return actual;
};
