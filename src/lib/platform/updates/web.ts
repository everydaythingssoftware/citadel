import {
	type ServerService,
	type ServerUpdate,
	serverService,
} from "@/lib/services/server";
import {
	NO_UPDATE_ACTIONS,
	type SoftwareUpdateState,
	type SoftwareUpdateStatus,
} from "@/lib/updates/software-update";
import type { UpdatesAdapter } from "../types";

/** The server checks GitHub daily; asking it hourly is plenty. */
export const SERVER_UPDATE_POLL_MS = 60 * 60 * 1000;

const status = ({ details }: ServerUpdate): SoftwareUpdateStatus => {
	if (!details) return { kind: "idle" };
	switch (details.checks) {
		case "off":
			return { kind: "checksOff" };
		case "notForThisBuild":
			return { kind: "notForThisBuild" };
		case "on":
			if (details.available)
				return {
					kind: "available",
					version: details.available.version,
					releaseNotesUrl: details.available.url,
				};
			// Only a check that answered can say the server is current.
			return details.checkedAt ? { kind: "upToDate" } : { kind: "checking" };
	}
};

/**
 * The server's update state. Nothing installs from a browser, so it offers
 * no actions: the administrator updates the server however they run it.
 * Readers get the version alone, because the server sends them nothing more.
 */
export const fromServer = (update: ServerUpdate): SoftwareUpdateState => ({
	subject: "server",
	currentVersion: update.currentVersion,
	status: status(update),
	actions: NO_UPDATE_ACTIONS,
});

const notHere = async (): Promise<never> => {
	throw new Error("Updates install on the server, not from the browser");
};

export const createWebUpdates = (
	server: Pick<ServerService, "update"> = serverService,
	pollMs = SERVER_UPDATE_POLL_MS,
): UpdatesAdapter => {
	const state = async () => {
		const update = await server.update();
		return update ? fromServer(update) : null;
	};
	return {
		state,
		onChange: async (handler) => {
			const timer = globalThis.setInterval(() => {
				state()
					.then((next) => {
						if (next) handler(next);
					})
					.catch((error: unknown) => console.error("Server update:", error));
			}, pollMs);
			return () => globalThis.clearInterval(timer);
		},
		// Settings is a page in the browser, and opens on General.
		onShowRequested: async () => () => {},
		showInSettings: async () => {},
		check: notHere,
		later: notHere,
		updateNow: notHere,
	};
};

export const webUpdates = createWebUpdates();
