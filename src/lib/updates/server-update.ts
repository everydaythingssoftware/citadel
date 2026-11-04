import type { ServerUpdate, ServerVersion } from "@/lib/services/server";

export interface ServerUpdateRowView {
	label: string;
	description: string | null;
	/** Release notes for an available update. */
	releaseNotesUrl: string | null;
}

/**
 * What Settings → General → Server shows. Everyone sees the version;
 * administrators also see whether a newer release is out.
 */
export const serverUpdateRowView = (
	version: ServerVersion,
	update: ServerUpdate | null,
): ServerUpdateRowView => {
	const current = `Citadel ${version.version}`;
	if (!update)
		return { label: current, description: null, releaseNotesUrl: null };
	if (update.available)
		return {
			label: `Citadel ${update.available.version} is available`,
			description: `This server runs ${version.version}.`,
			releaseNotesUrl: update.available.url,
		};
	switch (update.checks) {
		case "on":
			return {
				label: `${current} is up to date`,
				description: update.checkedAt ? null : "Checking for updates…",
				releaseNotesUrl: null,
			};
		case "off":
			return {
				label: current,
				description: "Update checks are turned off on this server.",
				releaseNotesUrl: null,
			};
		case "notForThisBuild":
			return {
				label: current,
				description: "Nightly and development builds don't check for updates.",
				releaseNotesUrl: null,
			};
	}
};
