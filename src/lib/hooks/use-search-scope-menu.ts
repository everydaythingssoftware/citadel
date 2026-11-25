import type { RefObject } from "react";
import {
	type ContextMenuButton,
	type ContextMenuController,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { searchScopeMenuItems } from "@/lib/search-scope";
import { useLibraryView } from "@/stores/library-view/store";

/** The scope menu of the search field, with the props of its button. */
export interface SearchScopeMenu {
	menu: ContextMenuController;
	/** The props of the scope button of the search field. */
	button: ContextMenuButton;
}

/**
 * The scope menu of the search field. Focus returns to the search input when
 * the user selects an item or presses Escape.
 */
export const useSearchScopeMenu = (
	searchInputRef: RefObject<HTMLInputElement | null>,
): SearchScopeMenu => {
	const searchScope = useLibraryView((s) => s.searchScope);
	const setSearchScope = useLibraryView((s) => s.setSearchScope);
	const menu = useContextMenu();
	return {
		menu,
		button: menu.menuButton(
			searchScopeMenuItems(searchScope, setSearchScope),
			"Search scope",
			{ returnFocus: searchInputRef },
		),
	};
};
