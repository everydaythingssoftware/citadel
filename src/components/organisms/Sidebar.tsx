import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { F7Gear } from "@/components/icons/F7Gear";
import { F7Pencil } from "@/components/icons/F7Pencil";
import { F7Trash } from "@/components/icons/F7Trash";
import { AlertDialog, IconButton, TextInput } from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { useAppUpdates } from "@/lib/hooks/use-app-updates";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import type { SmartShelf } from "@/lib/platform/settings/types";
import { LibraryState, useLibraryState } from "@/stores/library/store";
import { useLibraryView } from "@/stores/library-view/store";
import { deleteSmartShelf, renameSmartShelf } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";
import { LibraryPicker } from "./LibraryPicker";
import styles from "./Sidebar.module.css";

export const Sidebar = () => {
	const state = useLibraryState();
	const { location } = useRouterState();
	const openSettings = useOpenSettings();

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
				onConfirm={() => void installAvailableUpdate()}
			/>
			<SidebarPure
				currentPathname={location.pathname}
				openSettings={openSettings}
			/>
		</>
	);
};

interface SidebarPureProps {
	currentPathname: string;
	openSettings: () => void;
}

const SidebarPure = ({ currentPathname, openSettings }: SidebarPureProps) => {
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
					{libraryCount >= 2 ? (
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
			<div className={styles.section}>
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
