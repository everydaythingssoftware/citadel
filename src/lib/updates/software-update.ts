/**
 * Whether a newer Citadel is out, and what can be done about it here. One
 * model for both platforms: on the desktop it's the app, which updates
 * itself (CDL-51); in the browser it's the server, which an administrator
 * updates however they run it (CDL-73). Each platform's updates adapter
 * maps its own answer into this, and says which actions it can perform.
 */
export type UpdateSubject = "app" | "server";

export type SoftwareUpdateStatus =
	| { kind: "idle" }
	| { kind: "checking" }
	| { kind: "upToDate" }
	| {
			kind: "available";
			version: string;
			/** Where to read about it, when the platform links there. */
			releaseNotesUrl?: string | null;
	  }
	| { kind: "downloading"; version: string; progress: number | null }
	/** Downloaded and verified; installs when Citadel quits. */
	| { kind: "ready"; version: string }
	| { kind: "checkFailed"; message: string }
	| { kind: "updateFailed"; version: string; message: string }
	/** Turned off where Citadel runs. */
	| { kind: "checksOff" }
	/** Nightly and development builds have no release to compare with. */
	| { kind: "notForThisBuild" };

/** What this platform can do about updates. */
export interface UpdateActions {
	check: boolean;
	install: boolean;
	/** Install when Citadel quits (not for installs that need a password). */
	installOnQuit: boolean;
}

export const NO_UPDATE_ACTIONS: UpdateActions = {
	check: false,
	install: false,
	installOnQuit: false,
};

export interface SoftwareUpdateState {
	subject: UpdateSubject;
	currentVersion: string;
	status: SoftwareUpdateStatus;
	actions: UpdateActions;
}

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
	| { kind: "retryUpdate" }
	| { kind: "releaseNotes"; url: string };

export interface SoftwareUpdateRowView {
	label: string;
	/** A line under the label, for what the label alone can't say. */
	description?: string;
	/** Error text, shown on hover rather than taking up space. */
	detail?: string;
	controls: SoftwareUpdateControl[];
}

const SERVER_DESCRIPTIONS: Partial<
	Record<SoftwareUpdateStatus["kind"], string>
> = {
	checking: "Checking for updates…",
	checksOff: "Update checks are turned off on this server.",
	notForThisBuild: "Nightly and development builds don't check for updates.",
};

/** What Settings → Software Update shows for a state. */
export const softwareUpdateRowView = ({
	subject,
	currentVersion,
	status,
	actions,
}: SoftwareUpdateState): SoftwareUpdateRowView => {
	const current = `Citadel ${currentVersion}`;
	const check = (checking: boolean): SoftwareUpdateControl[] =>
		actions.check ? [{ kind: "check", checking }] : [];
	// A server can't be updated from the browser: it says what's out, and
	// the administrator updates however they run it.
	if (subject === "server") {
		if (status.kind === "available")
			return {
				label: `Citadel ${status.version} is available`,
				description: `This server runs ${currentVersion}.`,
				controls: status.releaseNotesUrl
					? [{ kind: "releaseNotes", url: status.releaseNotesUrl }]
					: [],
			};
		if (status.kind === "upToDate")
			return { label: `${current} is up to date`, controls: [] };
		const description = SERVER_DESCRIPTIONS[status.kind];
		return description
			? { label: current, description, controls: [] }
			: { label: current, controls: [] };
	}
	switch (status.kind) {
		case "idle":
		case "checksOff":
		case "notForThisBuild":
			return { label: current, controls: check(false) };
		case "checking":
			return { label: current, controls: check(true) };
		case "upToDate":
			return { label: `${current} is up to date`, controls: check(false) };
		case "available":
			return {
				label: `Update available: ${status.version}`,
				controls: !actions.install
					? []
					: actions.installOnQuit
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
				controls: actions.install ? [{ kind: "restartNow" }] : [],
			};
		case "checkFailed":
			return {
				label: "Couldn't check for updates",
				detail: status.message,
				controls: actions.check ? [{ kind: "retryCheck" }] : [],
			};
		case "updateFailed":
			return {
				label: `Couldn't install ${status.version}`,
				detail: status.message,
				controls: actions.install ? [{ kind: "retryUpdate" }] : [],
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
