import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import type { ContextMenuEntry } from "@/lib/context-menu";
import {
	type BrowserSessionControls,
	useBrowserSessionControls,
} from "@/lib/hooks/use-browser-session";
import {
	type ContextMenuController,
	type ContextMenuTarget,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { useLibraryActionsMenu } from "@/lib/hooks/use-library-actions-menu";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import type { RemoveLibrary } from "@/lib/hooks/use-remove-library";
import {
	type ShelfDelete,
	type ShelfRenameActions,
	useShelfDelete,
	useShelfRename,
} from "@/lib/hooks/use-shelf-actions";
import { useUpdateNotice } from "@/lib/hooks/use-update-notice";
import { none, type Option, some } from "@/lib/option";
import { usePlatform } from "@/lib/platform/context";
import type { SmartShelf } from "@/lib/platform/settings/types";
import {
	routeFiltersFromSearch,
	shelfInLibrary,
	shelfLeftRoute,
	shelfMatchesRoute,
	shelfRouteFilters,
} from "@/lib/shelves";
import { LibraryState, useLibraryState } from "@/stores/library/store";
import { useLibraryView } from "@/stores/library-view/store";
import { useSettings } from "@/stores/settings/store";

export interface SidebarShelf {
	shelf: SmartShelf;
	active: boolean;
	/** Its right-click menu, plus F2 to rename, as on Windows and in Finder. */
	keys: ContextMenuTarget;
}

export interface SidebarUpdateNotice {
	/** "Citadel 1.4 is ready". */
	title: string;
	onRestart: () => void;
	menu: ContextMenuTarget;
}

export interface SidebarViewModel {
	currentPathname: string;
	isAllBooksActive: boolean;
	onAllBooks: () => void;
	shelves: SidebarShelf[];
	onOpenShelf: (shelf: SmartShelf) => void;
	rename: ShelfRenameActions;
	updateNotice: Option<SidebarUpdateNotice>;
	showSettingsButton: boolean;
	settingsShowing: boolean;
	onOpenSettings: () => void;
	/** The signed-in browser user; null on desktop. */
	session: BrowserSessionControls | null;
}

export interface SidebarModel {
	view: SidebarViewModel;
	/** Two or more local libraries: the header switches between them. */
	libraryPicker: boolean;
	/** The open library's own menu (Show in Finder, Forget…). */
	libraryMenu: Option<ContextMenuTarget>;
	contextMenu: ContextMenuController;
	shelfDelete: ShelfDelete;
	removeLibrary: RemoveLibrary;
}

/** Everything the library window's sidebar shows; none until a library is open. */
export const useSidebarModel = (): Option<SidebarModel> => {
	const state = useLibraryState();
	const { location } = useRouterState();
	const navigate = useNavigate();
	const platform = usePlatform();
	const onOpenSettings = useOpenSettings();
	const session = useBrowserSessionControls();
	const notice = useUpdateNotice();
	const contextMenu = useContextMenu();
	const rename = useShelfRename();
	const shelfDelete = useShelfDelete();
	const libraryActions = useLibraryActionsMenu();

	const allShelves = useSettings((s) => s.smartShelves);
	const libraryId = useLibrarySelection().activeLibrary?.id;
	const smartShelves = useMemo(
		() => allShelves.filter((shelf) => shelfInLibrary(shelf.filter, libraryId)),
		[allShelves, libraryId],
	);
	const libraryCount = useSettings((s) => s.libraryPaths.length);
	const hydrated = useSettings((s) => s.hydrated);
	const activeShelfId = useLibraryView((s) => s.activeShelfId);
	const applyShelf = useLibraryView((s) => s.applyShelf);
	const resetToAllBooks = useLibraryView((s) => s.resetToAllBooks);
	const clearMissingActiveShelf = useLibraryView(
		(s) => s.clearMissingActiveShelf,
	);
	const detachShelf = useLibraryView((s) => s.detachShelf);
	const currentPathname = location.pathname;
	const routeFilters = routeFiltersFromSearch(location.search);
	const { author_id, series_id, tag_id, publisher_id } = routeFilters;

	// activeShelfId comes from localStorage, shelves from settings.json; drop a
	// shelf id that no longer exists once settings have hydrated.
	useEffect(() => {
		if (hydrated) {
			clearMissingActiveShelf(smartShelves.map((shelf) => shelf.id));
		}
	}, [hydrated, smartShelves, clearMissingActiveShelf]);

	// A shelf is only "showing" while the route carries its tag/author/series/
	// publisher filter. When the route stops matching (the filter token was
	// removed, or the app relaunched on a bare route), release the shelf
	// rather than label a different view with its name.
	useEffect(() => {
		if (!hydrated || currentPathname !== "/") return;
		const { activeShelfId: currentId } = useLibraryView.getState();
		const active = smartShelves.find((shelf) => shelf.id === currentId);
		if (
			shelfLeftRoute(
				{ author_id, series_id, tag_id, publisher_id },
				active?.filter,
			)
		) {
			detachShelf();
		}
	}, [
		hydrated,
		currentPathname,
		smartShelves,
		author_id,
		series_id,
		tag_id,
		publisher_id,
		detachShelf,
	]);

	if (state !== LibraryState.ready) return none();

	const shelfKeys = (shelf: SmartShelf): ContextMenuTarget => {
		const items: ContextMenuEntry[] = [
			{
				id: "rename",
				label: "Rename",
				onSelect: () => rename.startRename(shelf),
			},
			{ type: "separator", id: "rename-separator" },
			{
				id: "delete",
				label: "Delete…",
				destructive: true,
				onSelect: () => shelfDelete.requestDelete(shelf),
			},
		];
		const menu = contextMenu.target(items, `Shelf ${shelf.name}`);
		return {
			onContextMenu: menu.onContextMenu,
			onKeyDown: (event) => {
				if (event.key !== "F2") return menu.onKeyDown(event);
				event.preventDefault();
				rename.startRename(shelf);
			},
		};
	};

	return some({
		view: {
			currentPathname,
			// A book opened from the grid still belongs to All Books.
			isAllBooksActive:
				(currentPathname === "/" || currentPathname.startsWith("/books/")) &&
				activeShelfId === null,
			onAllBooks: resetToAllBooks,
			shelves: smartShelves.map((shelf) => ({
				shelf,
				active:
					currentPathname === "/" &&
					activeShelfId === shelf.id &&
					shelfMatchesRoute(shelf.filter, routeFilters),
				keys: shelfKeys(shelf),
			})),
			onOpenShelf: (shelf) => {
				applyShelf(shelf);
				void navigate({ to: "/", search: shelfRouteFilters(shelf.filter) });
			},
			rename,
			updateNotice: notice.isSome
				? some({
						title: notice.value.title,
						onRestart: notice.value.restart,
						menu: contextMenu.target(
							[
								{
									id: "hide",
									label: "Hide Until Next Update",
									onSelect: notice.value.hide,
								},
							],
							"Update actions",
						),
					})
				: none(),
			showSettingsButton: !(
				platform.capabilities.supportsNativeWindows && platform.os === "macos"
			),
			settingsShowing: currentPathname === "/settings",
			onOpenSettings,
			session,
		},
		libraryPicker: platform.capabilities.canPickLocalFiles && libraryCount >= 2,
		libraryMenu: libraryActions.items.isSome
			? some(contextMenu.target(libraryActions.items.value, "Library actions"))
			: none(),
		contextMenu,
		shelfDelete,
		removeLibrary: libraryActions.remove,
	});
};
