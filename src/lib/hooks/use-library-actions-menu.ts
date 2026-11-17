import { useMemo } from "react";
import type { ContextMenuEntry } from "@/lib/context-menu";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import {
	type RemoveLibrary,
	useRemoveLibrary,
} from "@/lib/hooks/use-remove-library";
import { none, type Option, some } from "@/lib/option";
import { usePlatform } from "@/lib/platform/context";

export interface LibraryActionsMenu {
	/** None where the library isn't a folder on this computer (the web). */
	items: Option<ContextMenuEntry[]>;
	remove: RemoveLibrary;
}

/**
 * The open library's right-click menu in the sidebar: Show in Finder, and
 * Forget…, which asks once and leaves the files alone (RemoveLibraryDialog).
 */
export const useLibraryActionsMenu = (): LibraryActionsMenu => {
	const platform = usePlatform();
	const { activeLibrary } = useLibrarySelection();
	const remove = useRemoveLibrary();
	const { request } = remove;

	const items = useMemo((): Option<ContextMenuEntry[]> => {
		if (!platform.capabilities.supportsNativeWindows || !activeLibrary) {
			return none();
		}
		const reveal: ContextMenuEntry[] = platform.capabilities
			.canRevealInFileManager
			? [
					{
						id: "reveal",
						label: `Show in ${platform.fileOpener.fileManagerName}`,
						onSelect: () => {
							platform.fileOpener
								.revealInFileManager(activeLibrary.absolutePath)
								.catch((error: unknown) =>
									console.error("Show library:", error),
								);
						},
					},
					{ type: "separator", id: "reveal-separator" },
				]
			: [];
		return some([
			...reveal,
			{
				id: "forget",
				label: "Forget…",
				onSelect: () => request(activeLibrary),
			},
		]);
	}, [platform, activeLibrary, request]);

	return { items, remove };
};
