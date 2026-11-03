import { createCitadelHttpClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.generated";

export type SessionInfo = components["schemas"]["SessionInfo"];
/** Whether the server has an administrator and a library yet; public. */
export type SetupStatus = components["schemas"]["SetupStatus"];

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
				throw new Error(
					error?.message ?? `Could not reach Citadel (${response.status})`,
				);
			return data;
		},
		signIn: async (username, password) => {
			const { data, error, response } = await client.POST("/api/session", {
				body: { username, password },
			});
			if (error || !data)
				throw new Error(
					error?.message ?? `Could not sign in (${response.status})`,
				);
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
				throw new Error(
					error?.message ?? `Could not reach Citadel (${response.status})`,
				);
			return data;
		},
		createAdministrator: async (setupCode, username, password) => {
			const { data, error, response } = await client.POST(
				"/api/setup/administrator",
				{ body: { setupCode, username, password } },
			);
			if (error || !data)
				throw new Error(
					error?.message ??
						`Could not create the administrator (${response.status})`,
				);
			return data;
		},
	};
};
