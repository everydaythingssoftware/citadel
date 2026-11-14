import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import clsx from "clsx";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { TablerLogout } from "@/components/icons/TablerLogout";
import { SettingsButton } from "@/components/molecules/SettingsButton";
import { UpdateNoticeRow } from "@/components/molecules/UpdateNoticeRow";
import { RemoveLibraryDialog } from "@/components/organisms/RemoveLibraryDialog";
import {
	AlertDialog,
	ContextMenu,
	NoBreak,
	TextInput,
	Tooltip,
} from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import type { ContextMenuEntry } from "@/lib/context-menu";
import { keyboardMenuAnchor } from "@/lib/context-menu-key";
import {
	type BrowserSessionControls,
	useBrowserSessionControls,
} from "@/lib/hooks/use-browser-session";
import {
	type ContextMenuController,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { useLibraryActionsMenu } from "@/lib/hooks/use-library-actions-menu";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import {
	type ShelfActions,
	useShelfActions,
} from "@/lib/hooks/use-shelf-actions";
import { useSoftwareUpdate } from "@/lib/hooks/use-software-update";
import {
	type UpdateNotice,
	useUpdateNotice,
} from "@/lib/hooks/use-update-notice";
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
import { LibraryPicker } from "./LibraryPicker";
import styles from "./Sidebar.module.css";

const NAV_ITEMS = [
	{ to: "/authors", label: "Authors" },
	{ to: "/series", label: "Series" },
	{ to: "/tags", label: "Tags" },
	{ to: "/publishers", label: "Publishers" },
] as const;

/**
 * Opens `items` from a right-click, or from the Menu key / Shift+F10, and
 * remembers the control so focus can go back to it.
 */
const menuOpeners = (
	menu: ContextMenuController,
	returnFocus: React.RefObject<HTMLElement | null>,
	items: ContextMenuEntry[] | null,
	label: string,
) =>
	items
		? {
				onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
					returnFocus.current = event.currentTarget;
					menu.openAt(event, items, label);
				},
				onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
					const anchor = keyboardMenuAnchor(
						event,
						event.currentTarget.getBoundingClientRect(),
					);
					if (!anchor) return;
					returnFocus.current = event.currentTarget;
					menu.openAt(anchor, items, label);
				},
			}
		: {};

export const Sidebar = () => {
	const state = useLibraryState();
	const { location } = useRouterState();
	const navigate = useNavigate();
	const platform = usePlatform();
	const openSettings = useOpenSettings();
	const session = useBrowserSessionControls();
	const notice = useUpdateNotice(useSoftwareUpdate());
	const menu = useContextMenu();
	const menuReturnFocus = useRef<HTMLElement | null>(null);
	const shelfActions = useShelfActions();
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

	if (state !== LibraryState.ready) {
		return null;
	}

	const libraryMenu = menuOpeners(
		menu,
		menuReturnFocus,
		libraryActions.items,
		"Library actions",
	);
	const shelfMenu = (shelf: SmartShelf) =>
		menuOpeners(
			menu,
			menuReturnFocus,
			[
				{
					id: "rename",
					label: "Rename",
					onSelect: () => shelfActions.startRename(shelf),
				},
				{ type: "separator", id: "rename-separator" },
				{
					id: "delete",
					label: "Delete…",
					destructive: true,
					onSelect: () => shelfActions.requestDelete(shelf),
				},
			],
			`Shelf ${shelf.name}`,
		);
	const updateMenu = notice
		? menuOpeners(
				menu,
				menuReturnFocus,
				[
					{
						id: "hide",
						label: "Hide Until Next Update",
						onSelect: notice.hide,
					},
				],
				"Update actions",
			)
		: {};

	return (
		<>
			<SidebarView
				libraryHeader={
					platform.capabilities.canPickLocalFiles && libraryCount >= 2 ? (
						<LibraryPicker {...libraryMenu} />
					) : (
						<h2
							className={styles.sectionLabel}
							onContextMenu={libraryMenu.onContextMenu}
						>
							Library
						</h2>
					)
				}
				currentPathname={currentPathname}
				isAllBooksActive={
					// A book opened from the grid still belongs to All Books.
					(currentPathname === "/" || currentPathname.startsWith("/books/")) &&
					activeShelfId === null
				}
				onAllBooks={resetToAllBooks}
				shelves={smartShelves.map((shelf) => ({
					shelf,
					active:
						currentPathname === "/" &&
						activeShelfId === shelf.id &&
						shelfMatchesRoute(shelf.filter, routeFilters),
				}))}
				onOpenShelf={(shelf) => {
					applyShelf(shelf);
					void navigate({ to: "/", search: shelfRouteFilters(shelf.filter) });
				}}
				shelfMenu={shelfMenu}
				shelfActions={shelfActions}
				updateNotice={notice}
				updateMenu={updateMenu}
				// Settings opens with ⌘, and from the app menu on the Mac.
				showSettingsButton={
					!(
						platform.capabilities.supportsNativeWindows &&
						platform.os === "macos"
					)
				}
				settingsShowing={currentPathname === "/settings"}
				onOpenSettings={openSettings}
				session={session}
			/>
			<ContextMenu
				menu={menu.menu}
				returnFocusRef={menuReturnFocus}
				onClose={menu.close}
			/>
			<DeleteShelfDialog actions={shelfActions} />
			<RemoveLibraryDialog remove={libraryActions.remove} />
		</>
	);
};

interface MenuOpeners {
	onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
	onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export interface SidebarShelf {
	shelf: SmartShelf;
	active: boolean;
}

export interface SidebarViewProps {
	/** The library picker, or the plain "Library" header. */
	libraryHeader: ReactNode;
	currentPathname: string;
	isAllBooksActive: boolean;
	onAllBooks: () => void;
	shelves: SidebarShelf[];
	onOpenShelf: (shelf: SmartShelf) => void;
	shelfMenu: (shelf: SmartShelf) => MenuOpeners;
	shelfActions: Pick<
		ShelfActions,
		"rename" | "startRename" | "editRename" | "commitRename" | "cancelRename"
	>;
	updateNotice: UpdateNotice | null;
	updateMenu: MenuOpeners;
	showSettingsButton: boolean;
	settingsShowing: boolean;
	onOpenSettings: () => void;
	/** The signed-in browser user; null on desktop. */
	session: BrowserSessionControls | null;
}

export const SidebarView = ({
	libraryHeader,
	currentPathname,
	isAllBooksActive,
	onAllBooks,
	shelves,
	onOpenShelf,
	shelfMenu,
	shelfActions,
	updateNotice,
	updateMenu,
	showSettingsButton,
	settingsShowing,
	onOpenSettings,
	session,
}: SidebarViewProps) => {
	const footerBar = session !== null || showSettingsButton;
	return (
		<div className={styles.root}>
			<div className={clsx(styles.sections, "ctd-scroller")}>
				<div className={styles.section}>
					{libraryHeader}
					<Link
						to="/"
						className={styles.navLink}
						data-active={isAllBooksActive || undefined}
						onClick={onAllBooks}
					>
						All Books
					</Link>
					{NAV_ITEMS.map(({ to, label }) => (
						<Link
							key={to}
							to={to}
							className={styles.navLink}
							data-active={currentPathname === to || undefined}
						>
							{label}
						</Link>
					))}
				</div>
				{shelves.length > 0 && (
					<div className={styles.section}>
						<h2 className={styles.sectionLabel}>Shelves</h2>
						{shelves.map(({ shelf, active }) => (
							<ShelfRow
								key={shelf.id}
								shelf={shelf}
								isActive={active}
								onOpen={() => onOpenShelf(shelf)}
								menu={shelfMenu(shelf)}
								actions={shelfActions}
							/>
						))}
					</div>
				)}
			</div>
			{(updateNotice || footerBar) && (
				<div className={styles.footer}>
					{updateNotice && (
						<UpdateNoticeRow
							title={updateNotice.title}
							onRestart={updateNotice.restart}
							{...updateMenu}
						/>
					)}
					{footerBar && (
						<div className={styles.footerBar}>
							{session && (
								<Tooltip label={`Signed in as ${session.username}`}>
									<button
										type="button"
										className={styles.signOut}
										onClick={safeAsyncEventHandler(session.signOut)}
									>
										<TablerLogout width={15} height={15} aria-hidden="true" />
										Sign Out
									</button>
								</Tooltip>
							)}
							{showSettingsButton && (
								<SettingsButton
									active={settingsShowing}
									onClick={onOpenSettings}
									className={styles.settingsButton}
								/>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
};

interface ShelfRowProps {
	shelf: SmartShelf;
	isActive: boolean;
	onOpen: () => void;
	menu: MenuOpeners;
	actions: SidebarViewProps["shelfActions"];
}

const ShelfRow = ({
	shelf,
	isActive,
	onOpen,
	menu,
	actions,
}: ShelfRowProps) => {
	const { rename } = actions;
	if (rename?.shelfId === shelf.id) {
		return (
			<TextInput
				value={rename.draft}
				error={rename.error}
				aria-label={`Shelf name for ${shelf.name}`}
				autoFocus
				onFocus={(event) => event.currentTarget.select()}
				className={styles.renameInput}
				onChange={(event) => actions.editRename(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						void actions.commitRename();
					} else if (event.key === "Escape") {
						actions.cancelRename();
					}
				}}
				onBlur={() => void actions.commitRename()}
			/>
		);
	}

	return (
		<button
			type="button"
			className={clsx(styles.navLink, styles.shelfNavLink)}
			data-active={isActive || undefined}
			onClick={onOpen}
			onContextMenu={menu.onContextMenu}
			onKeyDown={(event) => {
				// F2 renames, as on Windows and in Finder's own sidebar.
				if (event.key === "F2") {
					event.preventDefault();
					actions.startRename(shelf);
					return;
				}
				menu.onKeyDown?.(event);
			}}
		>
			<span className={styles.shelfName}>{shelf.name}</span>
		</button>
	);
};

const DeleteShelfDialog = ({ actions }: { actions: ShelfActions }) => {
	const { deleteStep } = actions;
	const name = deleteStep.id === "confirm" ? deleteStep.shelf.name : null;
	// Kept through the closing animation, so the title never empties.
	const shown = useRef("");
	if (name !== null) shown.current = name;

	return (
		<AlertDialog
			open={deleteStep.id === "confirm"}
			onOpenChange={(open) => {
				if (!open) actions.cancelDelete();
			}}
			title={
				<>
					Delete Shelf <NoBreak>“{shown.current}”</NoBreak>?
				</>
			}
			description="Your books stay in the library."
			confirmLabel="Delete"
			destructive
			onConfirm={actions.confirmDelete}
		/>
	);
};
