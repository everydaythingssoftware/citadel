import { useEffect, useState } from "react";
import { useBrowserSessionControls } from "@/lib/hooks/use-browser-session";
import {
	type ServerUpdate,
	type ServerVersion,
	serverService,
} from "@/lib/services/server";

/** The server checks GitHub daily; asking it hourly is plenty. */
const REFRESH_MS = 60 * 60 * 1000;

export interface ServerUpdateState {
	version: ServerVersion | null;
	/** Administrators only; null for readers and on the desktop. */
	update: ServerUpdate | null;
}

/**
 * Which Citadel the server runs, and for administrators whether a newer
 * release is out. Inert outside a signed-in browser session.
 */
export const useServerUpdate = (): ServerUpdateState => {
	const session = useBrowserSessionControls();
	const signedIn = session !== null;
	const administrator = session?.administrator ?? false;
	const [state, setState] = useState<ServerUpdateState>({
		version: null,
		update: null,
	});

	useEffect(() => {
		if (!signedIn) return;
		let cancelled = false;
		const load = () => {
			serverService
				.version()
				.then((version) => {
					if (!cancelled) setState((current) => ({ ...current, version }));
				})
				.catch((error: unknown) => console.error("Server version:", error));
			if (!administrator) return;
			serverService
				.update()
				.then((update) => {
					if (!cancelled) setState((current) => ({ ...current, update }));
				})
				.catch((error: unknown) => console.error("Server update:", error));
		};
		load();
		const timer = window.setInterval(load, REFRESH_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [signedIn, administrator]);

	return state;
};
