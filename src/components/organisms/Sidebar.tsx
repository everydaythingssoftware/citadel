import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import type { ReactNode } from "react";
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
import type { ContextMenuTarget } from "@/lib/hooks/use-context-menu";
import type { ShelfDelete } from "@/lib/hooks/use-shelf-actions";
import {
	type SidebarShelf,
	type SidebarViewModel,
	useSidebarModel,
} from "@/lib/hooks/use-sidebar-model";
import type { Option } from "@/lib/option";
import { LibraryPicker } from "./LibraryPicker";
import styles from "./Sidebar.module.css";

const NAV_ITEMS = [
	{ to: "/authors", label: "Authors" },
	{ to: "/series", label: "Series" },
	{ to: "/tags", label: "Tags" },
	{ to: "/publishers", label: "Publishers" },
] as const;

export const Sidebar = () => {
	const model = useSidebarModel();
	if (!model.isSome) return null;
	const {
		view,
		libraryPicker,
		libraryMenu,
		contextMenu,
		shelfDelete,
		removeLibrary,
	} = model.value;

	return (
		<>
			<SidebarView
				{...view}
				libraryHeader={
					libraryPicker ? (
						<LibraryPicker libraryMenu={libraryMenu} />
					) : (
						<LibraryHeading libraryMenu={libraryMenu} />
					)
				}
			/>
			<ContextMenu
				menu={contextMenu.menu}
				returnFocusRef={contextMenu.returnFocusRef}
				onClose={contextMenu.close}
			/>
			<DeleteShelfDialog shelfDelete={shelfDelete} />
			<RemoveLibraryDialog remove={removeLibrary} />
		</>
	);
};

/** With one library, its menu opens from the "Library" header itself. */
const LibraryHeading = ({
	libraryMenu,
}: {
	libraryMenu: Option<ContextMenuTarget>;
}) => (
	<h2 className={styles.sectionLabel}>
		{libraryMenu.isSome ? (
			<button
				type="button"
				className={styles.headingButton}
				aria-haspopup="menu"
				onClick={libraryMenu.value.onContextMenu}
				{...libraryMenu.value}
			>
				Library
			</button>
		) : (
			"Library"
		)}
	</h2>
);

export interface SidebarViewProps extends SidebarViewModel {
	/** The library picker, or the plain "Library" header. */
	libraryHeader: ReactNode;
}

export const SidebarView = ({
	libraryHeader,
	currentPathname,
	activeSectionPath,
	isAllBooksActive,
	onAllBooks,
	shelves,
	onOpenShelf,
	rename,
	updateNotice,
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
							data-active={
								(activeSectionPath ?? currentPathname) === to || undefined
							}
						>
							{label}
						</Link>
					))}
				</div>
				{shelves.length > 0 && (
					<div className={styles.section}>
						<h2 className={styles.sectionLabel}>Shelves</h2>
						{shelves.map((row) => (
							<ShelfRow
								key={row.shelf.id}
								row={row}
								onOpen={() => onOpenShelf(row.shelf)}
								rename={rename}
							/>
						))}
					</div>
				)}
			</div>
			{(updateNotice.isSome || footerBar) && (
				<div className={styles.footer}>
					{updateNotice.isSome && (
						<UpdateNoticeRow
							title={updateNotice.value.title}
							onRestart={updateNotice.value.onRestart}
							menu={updateNotice.value.menu}
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
										Sign out
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
	row: SidebarShelf;
	onOpen: () => void;
	rename: SidebarViewModel["rename"];
}

const ShelfRow = ({
	row: { shelf, active, keys },
	onOpen,
	rename,
}: ShelfRowProps) => {
	const { editing } = rename;
	if (editing.isSome && editing.value.shelfId === shelf.id) {
		return (
			<TextInput
				value={editing.value.draft}
				error={editing.value.error}
				aria-label={`Shelf name for ${shelf.name}`}
				autoFocus
				onFocus={(event) => event.currentTarget.select()}
				className={styles.renameInput}
				onChange={(event) => rename.editRename(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						void rename.commitRename();
					} else if (event.key === "Escape") {
						rename.cancelRename();
					}
				}}
				onBlur={() => void rename.commitRename()}
			/>
		);
	}

	return (
		<button
			type="button"
			className={clsx(styles.navLink, styles.shelfNavLink)}
			data-active={active || undefined}
			onClick={onOpen}
			{...keys}
		>
			<span className={styles.shelfName}>{shelf.name}</span>
		</button>
	);
};

const DeleteShelfDialog = ({ shelfDelete }: { shelfDelete: ShelfDelete }) => {
	const { confirming } = shelfDelete;
	return (
		<AlertDialog
			open={confirming.isSome}
			onOpenChange={(open) => {
				if (!open) shelfDelete.cancelDelete();
			}}
			title={
				<>
					Delete shelf{" "}
					<NoBreak>“{confirming.isSome ? confirming.value.name : ""}”</NoBreak>?
				</>
			}
			description="Your books stay in the library."
			confirmLabel="Delete"
			destructive
			onConfirm={shelfDelete.confirmDelete}
		/>
	);
};
