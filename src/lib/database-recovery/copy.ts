import type { DatabaseProblemKind, RecoveryStep } from "@/bindings";

/**
 * Every word about citadel.db problems: the recovery screen and the notice
 * after a damaged database was restored. Which steps appear for which problem
 * is decided by the backend (src-tauri/src/recovery.rs); only the wording
 * lives here.
 */
export const PROBLEM_COPY: Record<
	DatabaseProblemKind,
	{ title: string; lede: string }
> = {
	damaged: {
		title: "There’s a problem opening Citadel",
		lede: "Your books are safe. Citadel just lost track of where your libraries are, so you’ll need to add them again.",
	},
	newerVersion: {
		title: "Citadel needs to be updated",
		lede: "A newer version of Citadel was used on this Mac. Update to keep going where you left off.",
	},
	migrationFailed: {
		title: "There’s a problem opening Citadel",
		lede: "Your books and settings are safe. This version of Citadel couldn’t finish updating its settings; a newer version may fix it.",
	},
	migrationInterrupted: {
		title: "There’s a problem opening Citadel",
		lede: "Your books and settings are safe. Citadel was interrupted twice while updating its settings.",
	},
	unreadable: {
		title: "There’s a problem opening Citadel",
		lede: "Citadel can’t read its settings. Check that the folder in Details exists and that you can write to it, then open Citadel again.",
	},
};

type DateText = string | null;

export const STEP_COPY: Record<
	Exclude<RecoveryStep, "quit">,
	{ title: (date: DateText) => string; description: (date: DateText) => string }
> = {
	update: {
		title: () => "Update Citadel",
		description: () => "Download and install the latest version.",
	},
	restoreBackup: {
		title: (date) =>
			date ? `Restore from ${date}` : "Restore a previous version",
		description: () =>
			"Libraries you added or renamed since then will have to be added again.",
	},
	startFresh: {
		title: () => "Find My Libraries",
		description: () =>
			"Start over and add your libraries again. Reading apps will need a new sharing password.",
	},
	tryAgain: {
		title: () => "Try Again",
		description: () => "Run the update once more.",
	},
};

export const QUIT_LABEL = "Quit Citadel";
export const DETAILS_LABEL = "Details";
export const REVEAL_LABEL = "Show in Folder";
export const WORKING_LABEL = "Working…";
export const FAILED_PREFIX = "That didn’t work:";
export const NO_UPDATE_MESSAGE = "There isn’t a newer version of Citadel yet.";

/** Shown once the app opens on a backup that replaced a damaged database. */
export const RESTORED_NOTICE = {
	title: "Citadel restored your settings",
	message: (date: DateText) =>
		`Citadel had a problem and had to restore a previous version of your settings${date ? ` from ${date}` : ""}. Libraries you added or renamed since then will have to be added again.`,
};

export const formatBackupDate = (createdAt: string | null): DateText =>
	createdAt
		? new Date(createdAt).toLocaleDateString("en-CA", { dateStyle: "long" })
		: null;
