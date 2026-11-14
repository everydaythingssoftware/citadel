import type { OperatingSystem } from "../os";

/** What the system's file manager is called, for "Show in …" labels. */
export const fileManagerNameFor = (os: OperatingSystem): string => {
	switch (os) {
		case "macos":
			return "Finder";
		case "windows":
			return "File Explorer";
		case "ios":
			return "Files";
		default:
			return "File Manager";
	}
};
