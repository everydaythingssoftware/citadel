import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";

let cachedHome: string | null = null;

/**
 * The user's home directory (no trailing slash), or null until known / on
 * non-Tauri platforms. Used to render paths the macOS way (`~/Books/…`).
 */
export const useHomeDir = (): string | null => {
	const [home, setHome] = useState<string | null>(cachedHome);

	useEffect(() => {
		if (cachedHome !== null) return;
		let alive = true;
		homeDir()
			.then((dir) => {
				cachedHome = dir.replace(/\/+$/, "");
				if (alive) setHome(cachedHome);
			})
			.catch(() => {
				// Non-Tauri platform: paths render unabbreviated.
			});
		return () => {
			alive = false;
		};
	}, []);

	return home;
};

/** `/Users/me/Books` → `~/Books` when the home directory is known. */
export const abbreviateHomePath = (
	path: string,
	home: string | null,
): string => {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};
