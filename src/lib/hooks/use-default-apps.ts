import { useEffect, useState } from "react";
import { type DefaultApp, fileTypeKey } from "@/lib/book-file-actions";
import { usePlatform } from "@/lib/platform/context";
import type { PlatformAdapter } from "@/lib/platform/types";

type Lookup = Promise<DefaultApp | null>;

const lookups = new WeakMap<PlatformAdapter, Map<string, Lookup>>();

const lookUp = (platform: PlatformAdapter, path: string): Lookup => {
	let byType = lookups.get(platform);
	if (!byType) {
		byType = new Map();
		lookups.set(platform, byType);
	}
	const key = fileTypeKey(path);
	const cached = byType.get(key);
	if (cached) return cached;
	const lookup = platform.fileOpener.defaultApp(path).catch(() => null);
	byType.set(key, lookup);
	return lookup;
};

/**
 * Each local file's default app, looked up once per file type: undefined
 * while asking, null when nothing claims it.
 */
export const useDefaultApps = (
	paths: string[],
): Record<string, DefaultApp | null | undefined> => {
	const platform = usePlatform();
	const [apps, setApps] = useState<Record<string, DefaultApp | null>>({});
	const key = paths.join("\n");

	useEffect(() => {
		let live = true;
		const wanted = key.length > 0 ? key.split("\n") : [];
		for (const path of wanted) {
			void lookUp(platform, path).then((app) => {
				if (live)
					setApps((previous) =>
						previous[path] === app ? previous : { ...previous, [path]: app },
					);
			});
		}
		return () => {
			live = false;
		};
	}, [platform, key]);

	return apps;
};
