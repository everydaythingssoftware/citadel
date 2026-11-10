/** What the system's file manager is called, for "Show in …" labels. */
export const fileManagerNameFor = (userAgent: string): string => {
	if (/Macintosh|Mac OS X/.test(userAgent)) return "Finder";
	if (/Windows/.test(userAgent)) return "File Explorer";
	return "File Manager";
};
