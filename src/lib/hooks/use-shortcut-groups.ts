import { useMemo } from "react";
import { shortcutEnvironment } from "@/lib/app-shortcuts";
import { usePlatform } from "@/lib/platform/context";
import { type ShortcutGroup, shortcutGroups } from "@/lib/shortcut-list";

/** The shortcuts that work here, grouped, as Settings lists them. */
export const useShortcutGroups = (): ShortcutGroup[] => {
	const platform = usePlatform();
	return useMemo(
		() =>
			shortcutGroups(shortcutEnvironment(platform), {
				fileManagerName: platform.fileOpener.fileManagerName,
				quickLook: platform.fileOpener.quickLook.isSome,
			}),
		[platform],
	);
};
