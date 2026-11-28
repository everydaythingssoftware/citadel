import { useEffect, useState } from "react";
import { usePlatform } from "@/lib/platform/context";

const cachedHomes = new WeakMap<
	ReturnType<typeof usePlatform>,
	string | null
>();

/**
 * The user's home directory (no trailing slash), or null until known / on
 * non-Tauri platforms. Used to render paths the macOS way (`~/Books/…`).
 */
export const useHomeDir = (): string | null => {
	const platform = usePlatform();
	const [home, setHome] = useState<string | null>(
		cachedHomes.get(platform) ?? null,
	);

	useEffect(() => {
		if (cachedHomes.has(platform)) {
			setHome(cachedHomes.get(platform) ?? null);
			return;
		}
		setHome(null);
		let alive = true;
		platform
			.homeDirectory()
			.then((dir) => {
				cachedHomes.set(platform, dir);
				if (alive) setHome(dir);
			})
			.catch(() => {
				// Non-Tauri platform: paths render unabbreviated.
			});
		return () => {
			alive = false;
		};
	}, [platform]);

	return home;
};

/** `/Users/me/Books` → `~/Books` when the home directory is known. */
export const abbreviateHomePath = (
	path: string,
	home: string | null,
): string => {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
		? `~${path.slice(home.length)}`
		: path;
};
