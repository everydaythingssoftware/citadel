import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { F7Gear } from "@/components/icons/F7Gear";
import { F7Pencil } from "@/components/icons/F7Pencil";
import { F7Trash } from "@/components/icons/F7Trash";
import { TablerLogout } from "@/components/icons/TablerLogout";
import { AlertDialog, IconButton, TextInput, Tooltip } from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { usePlatform } from "@/lib/platform/context";
import { useAppUpdates } from "@/lib/hooks/use-app-updates";
import {
	type BrowserSessionControls,
	useBrowserSessionControls,
} from "@/lib/hooks/use-browser-session";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import {
	type BookRouteFilters,
	routeFiltersFromSearch,
	shelfLeftRoute,
	shelfMatchesRoute,
	shelfRouteFilters,
} from "@/lib/shelves";
import type { SmartShelf } from "@/lib/platform/settings/types";
import { LibraryState, useLibraryState } from "@/stores/library/store";
import { useLibraryView } from "@/stores/library-view/store";
import { deleteSmartShelf, renameSmartShelf } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";
import { LibraryPicker } from "./LibraryPicker";
import styles from "./Sidebar.module.css";

export const Sidebar = () => {
	const platform = usePlatform();
	const state = useLibraryState();
	const { location } = useRouterState();
	const openSettings = useOpenSettings();
	const session = useBrowserSessionControls();

	const isUpdatePromptOpen = useAppUpdates((s) => s.isUpdatePromptOpen);
	const isInstallingUpdate = useAppUpdates((s) => s.isInstallingUpdate);
	const closeUpdatePrompt = useAppUpdates((s) => s.closeUpdatePrompt);
	const installAvailableUpdate = useAppUpdates((s) => s.installAvailableUpdate);

	if (state !== LibraryState.ready) {
		return null;
	}

	return (
		<>
			<AlertDialog
				open={isUpdatePromptOpen}
				onOpenChange={(open) => {
					// The old modal disabled escape/outside-click closes while the
					// update was installing; keep the prompt open in that state.
					// Read the flag from the store so the Action click (which sets
					// it synchronously before Radix requests the close) is seen.
					if (!open && !useAppUpdates.getState().isInstallingUpdate) {
						closeUpdatePrompt();
					}
				}}
				title="Update available"
				description="A new Citadel release is available. Install now?"
				confirmLabel={
					isInstallingUpdate ? "Installing…" : "Install and restart"
				}
				cancelLabel="Later"
				onConfirm={() => void installAvailableUpdate(platform)}
			/>
			<SidebarPure
				currentPathname={location.pathname}
				routeFilters={routeFiltersFromSearch(location.search)}
				openSettings={openSettings}
				session={session}
			/>
		</>
	);
};

interface SidebarPureProps {
	currentPathname: string;
	/** The Books route's deep-link filters, to tell which shelf is showing. */
	routeFilters: BookRouteFilters;
	openSettings: () => void;
	/** The signed-in browser user; null on desktop. */
	session: BrowserSessionControls | null;
}

const SidebarPure = ({
	currentPathname,
	routeFilters,
	openSettings,
	session,
}: SidebarPureProps) => {
	const platform = usePlatform();
	const smartShelves = useSettings((s) => s.smartShelves);
	const libraryCount = useSettings((s) => s.libraryPaths.length);
	const hydrated = useSettings((s) => s.hydrated);
	const activeShelfId = useLibraryView((s) => s.activeShelfId);
	const resetToAllBooks = useLibraryView((s) => s.resetToAllBooks);
	const clearMissingActiveShelf = useLibraryView(
		(s) => s.clearMissingActiveShelf,
	);
	const detachShelf = useLibraryView((s) => s.detachShelf);
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

	const isAllBooksActive = currentPathname === "/" && activeShelfId === null;

	return (
		<div className={styles.root}>
			<div className={styles.sections}>
				<div className={styles.section}>
					{platform.capabilities.canPickLocalFiles && libraryCount >= 2 ? (
						<LibraryPicker />
					) : (
						<h2 className={styles.sectionLabel}>Library</h2>
					)}
					<Link
						to="/"
						className={clsx("ctd-nav-link", styles.navLink)}
						data-active={isAllBooksActive || undefined}
						onClick={() => resetToAllBooks()}
					>
						All Books
					</Link>
					<Link
						to="/authors"
						className={clsx("ctd-nav-link", styles.navLink)}
						data-active={currentPathname === "/authors" || undefined}
					>
						Authors
					</Link>
					<Link
						to="/series"
						className={clsx("ctd-nav-link", styles.navLink)}
						data-active={currentPathname === "/series" || undefined}
					>
						Series
					</Link>
					<Link
						to="/tags"
						className={clsx("ctd-nav-link", styles.navLink)}
						data-active={currentPathname === "/tags" || undefined}
					>
						Tags
					</Link>
					<Link
						to="/publishers"
						className={clsx("ctd-nav-link", styles.navLink)}
						data-active={currentPathname === "/publishers" || undefined}
					>
						Publishers
					</Link>
				</div>
				{smartShelves.length > 0 && (
					<div className={styles.section}>
						<h2 className={styles.sectionLabel}>Shelves</h2>
						{smartShelves.map((shelf) => (
							<ShelfRow
								key={shelf.id}
								shelf={shelf}
								isActive={
									currentPathname === "/" &&
									activeShelfId === shelf.id &&
									shelfMatchesRoute(shelf.filter, routeFilters)
								}
							/>
						))}
					</div>
				)}
			</div>
			<div className={clsx(styles.section, session && styles.footer)}>
				{session && (
					<Tooltip label={`Signed in as ${session.username} · Sign out`}>
						<IconButton
							aria-label={`Sign out ${session.username}`}
							className={clsx("ctd-settings-button", styles.settingsButton)}
							onClick={safeAsyncEventHandler(session.signOut)}
						>
							<TablerLogout width={16} height={16} />
						</IconButton>
					</Tooltip>
				)}
				<IconButton
					aria-label="Settings"
					className={clsx("ctd-settings-button", styles.settingsButton)}
					onClick={openSettings}
				>
					{/* F7Gear hardcodes width/height 56; size it to fit the button. */}
					<F7Gear width={18} height={18} />
				</IconButton>
			</div>
		</div>
	);
};

interface ShelfRowProps {
	shelf: SmartShelf;
	isActive: boolean;
}

const ShelfRow = ({ shelf, isActive }: ShelfRowProps) => {
	const navigate = useNavigate();
	const applyShelf = useLibraryView((s) => s.applyShelf);
	const activeShelfId = useLibraryView((s) => s.activeShelfId);
	const resetToAllBooks = useLibraryView((s) => s.resetToAllBooks);

	const [isRenaming, setIsRenaming] = useState(false);
	const [draftName, setDraftName] = useState(shelf.name);
	const [renameError, setRenameError] = useState<string | null>(null);

	// Finder-style inline rename: Enter and blur both commit, Escape cancels.
	const commitRename = async () => {
		try {
			await renameSmartShelf(shelf.id, draftName);
			setIsRenaming(false);
		} catch (e) {
			setRenameError(e instanceof Error ? e.message : String(e));
		}
	};

	if (isRenaming) {
		return (
			<TextInput
				value={draftName}
				error={renameError}
				aria-label={`Shelf name for ${shelf.name}`}
				// biome-ignore lint/a11y/noAutofocus: inline rename replaces the row the user just clicked; focus must land in the input.
				autoFocus
				className={styles.renameInput}
				onChange={(event) => {
					setDraftName(event.currentTarget.value);
					setRenameError(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						void commitRename();
					} else if (event.key === "Escape") {
						setIsRenaming(false);
					}
				}}
				onBlur={() => void commitRename()}
			/>
		);
	}

	return (
		<div className={styles.shelfRow}>
			<button
				type="button"
				className={clsx("ctd-nav-link", styles.navLink, styles.shelfNavLink)}
				data-active={isActive || undefined}
				onClick={() => {
					applyShelf(shelf);
					void navigate({ to: "/", search: shelfRouteFilters(shelf.filter) });
				}}
			>
				<span className={styles.shelfName}>{shelf.name}</span>
			</button>
			<span className={styles.shelfControls}>
				<IconButton
					aria-label={`Rename shelf ${shelf.name}`}
					className={styles.shelfControlButton}
					onClick={() => {
						setDraftName(shelf.name);
						setRenameError(null);
						setIsRenaming(true);
					}}
				>
					<F7Pencil />
				</IconButton>
				<IconButton
					aria-label={`Delete shelf ${shelf.name}`}
					className={styles.shelfControlButton}
					onClick={safeAsyncEventHandler(async () => {
						await deleteSmartShelf(shelf.id);
						if (activeShelfId === shelf.id) {
							resetToAllBooks();
						}
					})}
				>
					<F7Trash />
				</IconButton>
			</span>
		</div>
	);
};
