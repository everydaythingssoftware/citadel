import type { RecoveryAdapter } from "../types";

/** The browser has no citadel.db of its own; the server reports its own. */
export const webRecovery: RecoveryAdapter = {
	problem: async () => null,
	restored: async () => null,
	recover: async () => {
		throw new Error("Database recovery is only available on desktop");
	},
};
