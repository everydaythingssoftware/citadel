export const UPDATE_CHECKS = {
	on: "on",
	off: "off",
	notForThisBuild: "notForThisBuild",
} as const;
export type UpdateChecks = (typeof UPDATE_CHECKS)[keyof typeof UPDATE_CHECKS];

export interface ServerRelease {
	version: string;
	/** The release notes page. */
	url: string;
	publishedAt: Date | null;
}

/** Administrators only: whether a newer release is out. */
export interface ServerUpdateDetails {
	checks: UpdateChecks;
	/** A release newer than the server, once a check has found one. */
	available: ServerRelease | null;
	/** When the server last heard from GitHub. */
	checkedAt: Date | null;
}

/** Which Citadel the server runs; details only for administrators. */
export interface ServerUpdate {
	currentVersion: string;
	details: ServerUpdateDetails | null;
}

/** The server itself, rather than its library. */
export interface ServerService {
	/** Null when signed out. */
	update(): Promise<ServerUpdate | null>;
}
