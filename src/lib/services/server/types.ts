/** Which Citadel a server is. */
export interface ServerVersion {
	version: string;
	commit: string;
	/** Version and commit; every response also carries it as `Citadel-Build`. */
	build: string;
}

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

/** What administrators are told about new releases. */
export interface ServerUpdate {
	currentVersion: string;
	checks: UpdateChecks;
	/** A release newer than the server, once a check has found one. */
	available: ServerRelease | null;
	checkedAt: Date | null;
}

/** The server itself, rather than its library. */
export interface ServerService {
	version(): Promise<ServerVersion>;
	/** Administrators only; null for anyone else. */
	update(): Promise<ServerUpdate | null>;
}
