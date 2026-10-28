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
		lede: "Your books are safe, but Citadel lost track of your libraries.",
	},
	newerVersion: {
		title: "Citadel needs to be updated",
		lede: "A newer version of Citadel was used on this Mac.",
	},
	migrationFailed: {
		title: "There’s a problem opening Citadel",
		lede: "Your books and settings are safe. An update may fix this.",
	},
	migrationInterrupted: {
		title: "There’s a problem opening Citadel",
		lede: "Your books and settings are safe. Citadel was interrupted while updating.",
	},
	unreadable: {
		title: "There’s a problem opening Citadel",
		lede: "Citadel couldn’t read its settings. Try restarting your Mac, then open Citadel again.",
	},
};

type DateText = string | null;

export const STEP_COPY: Record<
	Exclude<RecoveryStep, "quit">,
	{ title: (date: DateText) => string; description?: string }
> = {
	update: {
		title: () => "Update Citadel",
	},
	restoreBackup: {
		title: (date) =>
			date ? `Restore from ${date}` : "Restore a previous version",
		description: "Libraries added since then will need re-adding.",
	},
	startFresh: {
		title: () => "Find My Libraries",
		description: "Reading apps will need a new sharing password.",
	},
	tryAgain: {
		title: () => "Try Again",
	},
};

export const QUIT_LABEL = "Quit Citadel";
export const WORKING_LABEL = "Working…";
export const FAILED_PREFIX = "That didn’t work:";
export const NO_UPDATE_MESSAGE = "There isn’t a newer version of Citadel yet.";

/** Shown once the app opens on a backup that replaced a damaged database. */
export const RESTORED_NOTICE = {
	title: "Previous version restored",
	message: (date: DateText) =>
		`To recover from a problem, Citadel went back to your settings${date ? ` from ${date}` : ""}. Re-add any libraries you’ve added since.`,
};

/** "October 12" this year, "October 12, 2025" otherwise. */
export const formatBackupDate = (
	createdAt: string | null,
	now: Date = new Date(),
): DateText => {
	if (!createdAt) return null;
	const date = new Date(createdAt);
	return date.toLocaleDateString(
		"en-CA",
		date.getFullYear() === now.getFullYear()
			? { month: "long", day: "numeric" }
			: { dateStyle: "long" },
	);
};
