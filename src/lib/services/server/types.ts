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

export interface ServerAddress {
	/** An origin, such as `https://books.example.com`. */
	url: string;
}

/** Where browsers may reach the server. */
export interface ServerAddresses {
	/** The configured public URLs; empty means any address works. */
	addresses: ServerAddress[];
	/** The config file that sets them, or null for environment variables. */
	configFile: string | null;
	/** This machine's own address, such as `http://localhost:8081`; it always works. */
	alwaysIncluded: string | null;
	/** The address this page is using. */
	current: string | null;
	/** `current` is in the list, rather than allowed as this machine's own. */
	currentListed: boolean;
}

/** The server itself, rather than its library. */
export interface ServerService {
	/** Null when signed out. */
	update(): Promise<ServerUpdate | null>;
	/** Administrators only. */
	addresses(): Promise<ServerAddresses>;
}
