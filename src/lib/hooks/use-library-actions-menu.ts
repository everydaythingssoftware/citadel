import { useMemo } from "react";
import type { ContextMenuEntry } from "@/lib/context-menu";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import {
	type RemoveLibrary,
	useRemoveLibrary,
} from "@/lib/hooks/use-remove-library";
import { usePlatform } from "@/lib/platform/context";

export interface LibraryActionsMenu {
	/** Null where the library isn't a folder on this computer (the web). */
	items: ContextMenuEntry[] | null;
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

	const items = useMemo((): ContextMenuEntry[] | null => {
		if (!platform.capabilities.supportsNativeWindows || !activeLibrary) {
			return null;
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
		return [
			...reveal,
			{
				id: "forget",
				label: "Forget…",
				onSelect: () => request(activeLibrary),
			},
		];
	}, [platform, activeLibrary, request]);

	return { items, remove };
};
