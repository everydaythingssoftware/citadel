import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { F7Pencil } from "@/components/icons/F7Pencil";
import { F7Trash } from "@/components/icons/F7Trash";
import { TablerLogout } from "@/components/icons/TablerLogout";
import { SettingsButton } from "@/components/molecules/SettingsButton";
import { IconButton, TextInput, Tooltip } from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { usePlatform } from "@/lib/platform/context";
import {
	type BrowserSessionControls,
	useBrowserSessionControls,
} from "@/lib/hooks/use-browser-session";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import { useSoftwareUpdate } from "@/lib/hooks/use-software-update";
import type { SmartShelf } from "@/lib/platform/settings/types";
import { pendingUpdateVersion } from "@/lib/updates/software-update";
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
	const softwareUpdate = useSoftwareUpdate();
	const updateVersion = softwareUpdate
		? pendingUpdateVersion(softwareUpdate.state.status)
		: null;

	if (state !== LibraryState.ready) {
		return null;
	}

	return (
		<SidebarPure
			currentPathname={location.pathname}
			openSettings={
				updateVersion
					? safeAsyncEventHandler(platform.updates.showInSettings)
					: openSettings
			}
			updateVersion={updateVersion}
			session={session}
		/>
	);
};

interface SidebarPureProps {
	currentPathname: string;
	openSettings: () => void;
	/** Version of a waiting Citadel update; badges the gear. */
	updateVersion: string | null;
	/** The signed-in browser user; null on desktop. */
	session: BrowserSessionControls | null;
}

const SidebarPure = ({
	currentPathname,
	openSettings,
	updateVersion,
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

	// activeShelfId comes from localStorage, shelves from settings.json; drop a
	// shelf id that no longer exists once settings have hydrated.
	useEffect(() => {
		if (hydrated) {
			clearMissingActiveShelf(smartShelves.map((shelf) => shelf.id));
		}
	}, [hydrated, smartShelves, clearMissingActiveShelf]);

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
								isActive={currentPathname === "/" && activeShelfId === shelf.id}
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
				<SettingsButton
					updateVersion={updateVersion}
					onClick={openSettings}
					className={clsx("ctd-settings-button", styles.settingsButton)}
				/>
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
					void navigate({ to: "/" });
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
