import { createCitadelHttpClient } from "@/lib/api/client";

export { ServerUnreachableError } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.generated";

export type SessionInfo = components["schemas"]["SessionInfo"];
/** Whether the server has an administrator and a library yet; public. */
export type SetupStatus = components["schemas"]["SetupStatus"];

/**
 * The server isn't set up for the address this page was opened at (421).
 * The message names the address and how to add it.
 */
export class WrongAddressError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WrongAddressError";
	}
}

const MISDIRECTED = 421;
const TOO_MANY_REQUESTS = 429;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/** "in 30 seconds", "in 2 minutes", "in 1 hour", from `Retry-After`. */
const waitPhrase = (seconds: number): string => {
	const plural = (count: number, unit: string) =>
		`${count} ${unit}${count === 1 ? "" : "s"}`;
	if (seconds < SECONDS_PER_MINUTE) return `in ${plural(seconds, "second")}`;
	if (seconds < SECONDS_PER_HOUR)
		return `in ${plural(Math.ceil(seconds / SECONDS_PER_MINUTE), "minute")}`;
	return `in ${plural(Math.ceil(seconds / SECONDS_PER_HOUR), "hour")}`;
};

/** How long the server asked a refused sign-in to wait, if it said. */
const retryAfter = (response: Response): number | null => {
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
};

const failure = (
	error: { message?: string } | undefined,
	response: Response,
	fallback: string,
): Error => {
	if (response.status === MISDIRECTED)
		return new WrongAddressError(
			error?.message ?? "Citadel isn't set up for this address.",
		);
	const message = error?.message ?? `${fallback} (${response.status})`;
	const wait = retryAfter(response);
	return response.status === TOO_MANY_REQUESTS && wait !== null
		? new Error(`${message}. Try again ${waitPhrase(wait)}.`)
		: new Error(message);
};

/** Browser sign-in against the serving origin; the session lives in an HttpOnly cookie. */
export interface BrowserSession {
	/** The signed-in user, or null when the browser has no valid session. */
	current(): Promise<SessionInfo | null>;
	signIn(username: string, password: string): Promise<SessionInfo>;
	signOut(): Promise<void>;
	/** What a fresh server still needs; decides which form the gate shows. */
	setupStatus(): Promise<SetupStatus>;
	/** Creates the first administrator with the code the server printed, and signs them in. */
	createAdministrator(
		setupCode: string,
		username: string,
		password: string,
	): Promise<SessionInfo>;
}

export const createBrowserSession = (origin: string): BrowserSession => {
	const client = createCitadelHttpClient({
		baseUrl: origin,
		credentials: "same-origin",
	});
	return {
		current: async () => {
			const { data, error, response } = await client.GET("/api/session");
			if (response.status === 401) return null;
			if (error || !data)
				throw failure(error, response, "Could not reach Citadel");
			return data;
		},
		signIn: async (username, password) => {
			const { data, error, response } = await client.POST("/api/session", {
				body: { username, password },
			});
			if (error || !data) throw failure(error, response, "Could not sign in");
			return data;
		},
		signOut: async () => {
			const { error, response } = await client.DELETE("/api/session");
			if (error || !response.ok)
				throw new Error(
					error?.message ?? `Could not sign out (${response.status})`,
				);
		},
		setupStatus: async () => {
			const { data, error, response } = await client.GET("/api/setup");
			if (error || !data)
				throw failure(error, response, "Could not reach Citadel");
			return data;
		},
		createAdministrator: async (setupCode, username, password) => {
			const { data, error, response } = await client.POST(
				"/api/setup/administrator",
				{ body: { setupCode, username, password } },
			);
			if (error || !data)
				throw failure(error, response, "Could not create the administrator");
			return data;
		},
	};
};
