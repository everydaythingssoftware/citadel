import { type ReactNode, useRef, useState } from "react";
import { F7BookFill } from "@/components/icons/F7BookFill";
import {
	ContextMenu,
	type ContextMenuItem,
	type ContextMenuState,
	TextInput,
} from "@/components/ui";
import {
	type LibraryStatsState,
	useLibraryStats,
} from "@/lib/hooks/use-library-stats";
import { usePlatform } from "@/lib/platform/context";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { renameLibrary } from "@/stores/settings/actions";
import styles from "./LibraryListCard.module.css";

/** Outcome of adding a library; a failure's message shows under the row. */
export type AddLibraryResult = { ok: true } | { ok: false; message: string };

interface LibraryListCardProps {
	currentLibraryId: string;
	libraries: LibraryPath[];
	onSwitchLibrary: (id: string) => Promise<void>;
	/**
	 * Adds a library from a folder the user picks; null when they cancelled.
	 * Shows an "Add Library…" row at the end of the list when set.
	 */
	onAddLibrary?: () => Promise<AddLibraryResult | null>;
	/**
	 * Creates an empty library in a folder the user picks; null when they
	 * cancelled. Shows a "New Library…" row at the end of the list when set.
	 */
	onCreateLibrary?: () => Promise<AddLibraryResult | null>;
	/**
	 * Story seam: pre-resolved stats per library path. When omitted (the
	 * production path) each row fetches its own stats via useLibraryStats.
	 */
	statsByPath?: ReadonlyMap<string, LibraryStatsState>;
}

interface RenameState {
	id: string;
	draft: string;
	error: string | null;
}

const plural = (count: number, word: string) =>
	count === 1 ? word : `${word}s`;

const CheckmarkIcon = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 10 10"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M1.5 5.5L4 8l4.5-6"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

/**
 * "Libraries" card: one row per library, checkmark on the active one. Clicking
 * a row switches (the parent validates first); the context menu (right-click
 * or Menu key) renames any row and reveals its folder, and double-clicking the
 * active row's name enters the same inline rename.
 */
export const LibraryListCard = ({
	currentLibraryId,
	libraries,
	onSwitchLibrary,
	statsByPath,
	onAddLibrary,
	onCreateLibrary,
}: LibraryListCardProps) => {
	const platform = usePlatform();
	const [rename, setRename] = useState<RenameState | null>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [menuTargetId, setMenuTargetId] = useState<string | null>(null);
	const menuRowRef = useRef<HTMLButtonElement | null>(null);
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());

	const focusRow = (id: string) => {
		requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
	};

	const startRename = (id: string) => {
		const library = libraries.find((entry) => entry.id === id);
		if (!library) return;
		setRename({ id, draft: library.displayName, error: null });
	};

	const commitRename = async ({ refocusRow }: { refocusRow: boolean }) => {
		if (rename === null) return;
		const { id, draft } = rename;
		try {
			await renameLibrary(id, draft);
			// A rename started elsewhere in the meantime (blur-commit racing a
			// new edit) must not close it.
			setRename((current) => (current?.id === id ? null : current));
			if (refocusRow) focusRow(id);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			setRename((current) =>
				current === null || current.id !== id
					? current
					: { ...current, error: message },
			);
		}
	};

	const cancelRename = (id: string) => {
		setRename((current) => (current?.id === id ? null : current));
		focusRow(id);
	};

	const openMenu = (library: LibraryPath, x: number, y: number) => {
		const items: ContextMenuItem[] = [
			{
				id: "rename",
				label: "Rename",
				onSelect: () => startRename(library.id),
			},
		];
		if (platform.capabilities.canRevealInFileManager) {
			items.push({
				id: "reveal",
				label: "Reveal in Finder",
				onSelect: () => {
					void platform.fileOpener.revealInFileManager(library.absolutePath);
				},
			});
		}
		setMenuTargetId(library.id);
		setMenu({ x, y, items });
	};

	const closeMenu = () => {
		setMenu(null);
		setMenuTargetId(null);
	};

	return (
		<div>
			<h4 className={styles.cardTitle}>Libraries</h4>
			<div className={styles.card}>
				{libraries.map((library) => (
					<LibraryRow
						key={library.id}
						library={library}
						isActive={library.id === currentLibraryId}
						isMenuTarget={library.id === menuTargetId}
						isRenaming={rename?.id === library.id}
						renameDraft={rename?.draft ?? ""}
						renameError={rename?.error ?? null}
						statsOverride={statsByPath?.get(library.absolutePath)}
						rowRef={(node) => {
							if (node) rowRefs.current.set(library.id, node);
							else rowRefs.current.delete(library.id);
						}}
						onSwitchLibrary={onSwitchLibrary}
						onStartRename={startRename}
						onRenameDraftChange={(draft) =>
							setRename((current) =>
								current === null ? current : { ...current, draft, error: null },
							)
						}
						onCommitRename={commitRename}
						onCancelRename={cancelRename}
						onOpenMenu={(x, y, anchor) => {
							menuRowRef.current = anchor;
							openMenu(library, x, y);
						}}
					/>
				))}
				{onAddLibrary && (
					<LibraryActionRow
						label="Add Library…"
						busyLabel="Adding Library…"
						hint="Open a Calibre library folder from your Mac"
						icon={<PlusCircleIcon />}
						onAction={onAddLibrary}
					/>
				)}
				{onCreateLibrary && (
					<LibraryActionRow
						label="New Library…"
						busyLabel="Creating Library…"
						hint="Start an empty library in a new folder"
						icon={<NewFolderIcon />}
						onAction={onCreateLibrary}
					/>
				)}
			</div>
			<ContextMenu
				menu={menu}
				returnFocusRef={menuRowRef}
				onClose={closeMenu}
			/>
		</div>
	);
};

interface LibraryRowProps {
	library: LibraryPath;
	isActive: boolean;
	isMenuTarget: boolean;
	isRenaming: boolean;
	renameDraft: string;
	renameError: string | null;
	/** Story seam: overrides the row's own useLibraryStats fetch when set. */
	statsOverride?: LibraryStatsState;
	rowRef: (node: HTMLButtonElement | null) => void;
	onSwitchLibrary: (id: string) => Promise<void>;
	onStartRename: (id: string) => void;
	onRenameDraftChange: (draft: string) => void;
	onCommitRename: (options: { refocusRow: boolean }) => Promise<void>;
	onCancelRename: (id: string) => void;
	onOpenMenu: (x: number, y: number, anchor: HTMLButtonElement) => void;
}

const LibraryRow = ({
	library,
	isActive,
	isMenuTarget,
	isRenaming,
	renameDraft,
	renameError,
	statsOverride,
	rowRef,
	onSwitchLibrary,
	onStartRename,
	onRenameDraftChange,
	onCommitRename,
	onCancelRename,
	onOpenMenu,
}: LibraryRowProps) => {
	const fetchedStats = useLibraryStats(
		library.absolutePath,
		statsOverride === undefined,
	);
	const stats = statsOverride ?? fetchedStats;

	const openMenuFromPointer = (event: React.MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		onOpenMenu(event.clientX, event.clientY, event.currentTarget);
	};

	const openMenuFromKeyboard = (
		event: React.KeyboardEvent<HTMLButtonElement>,
	) => {
		if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))
			return;
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		onOpenMenu(rect.left + 12, rect.bottom + 4, event.currentTarget);
	};

	const subtitle =
		stats.status === "loading"
			? "…"
			: stats.status === "loaded"
				? `${stats.stats.book_count} ${plural(stats.stats.book_count, "book")}`
				: null;

	if (isRenaming) {
		return (
			<div className={styles.row}>
				<F7BookFill className={styles.rowIcon} aria-hidden="true" />
				<div className={styles.renameField}>
					<TextInput
						value={renameDraft}
						error={renameError}
						aria-label={`Library name for ${library.displayName}`}
						autoFocus
						className={styles.renameInput}
						onChange={(event) => onRenameDraftChange(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								void onCommitRename({ refocusRow: true });
							} else if (event.key === "Escape") {
								onCancelRename(library.id);
							}
						}}
						onBlur={() => void onCommitRename({ refocusRow: false })}
					/>
				</div>
			</div>
		);
	}

	return (
		<button
			ref={rowRef}
			type="button"
			className={styles.libraryRow}
			data-active={isActive || undefined}
			data-menu-target={isMenuTarget || undefined}
			onClick={() => {
				if (!isActive) void onSwitchLibrary(library.id);
			}}
			onContextMenu={openMenuFromPointer}
			onKeyDown={openMenuFromKeyboard}
		>
			<F7BookFill className={styles.rowIcon} aria-hidden="true" />
			<span className={styles.rowLabels}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Finder-style double-click rename lives on the name itself; keyboard users rename via the row context menu (Menu key) or the Current Library card's Name field. */}
				<span
					className={styles.rowName}
					onDoubleClick={() => {
						if (isActive) onStartRename(library.id);
					}}
				>
					{library.displayName}
				</span>
				{subtitle !== null && (
					<span className={styles.rowSubtitle}>{subtitle}</span>
				)}
			</span>
			<span className={styles.checkSlot} aria-hidden="true">
				{isActive ? <CheckmarkIcon /> : null}
			</span>
		</button>
	);
};

const PlusCircleIcon = () => (
	<svg className={styles.addIcon} viewBox="0 0 16 16" aria-hidden="true">
		<path
			fillRule="evenodd"
			d="M8 .75a7.25 7.25 0 1 0 0 14.5A7.25 7.25 0 1 0 8 .75ZM7.2 4.75h1.6V7.2h2.45v1.6H8.8v2.45H7.2V8.8H4.75V7.2H7.2Z"
		/>
	</svg>
);

const NewFolderIcon = () => (
	<svg className={styles.addIcon} viewBox="0 0 16 16" aria-hidden="true">
		<path
			fillRule="evenodd"
			d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.38a1.5 1.5 0 0 1 1.06.44L8.12 3.6H13.5A1.5 1.5 0 0 1 15 5.1v7.4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Zm6.25 3.75v1.5h-1.5v1.5h1.5v1.5h1.5v-1.5h1.5v-1.5h-1.5v-1.5h-1.5Z"
		/>
	</svg>
);

interface LibraryActionRowProps {
	label: string;
	busyLabel: string;
	hint: string;
	icon: ReactNode;
	onAction: () => Promise<AddLibraryResult | null>;
}

/** The list's own ways to grow: pick a folder, and a library joins the list. */
const LibraryActionRow = ({
	label,
	busyLabel,
	hint,
	icon,
	onAction,
}: LibraryActionRowProps) => {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<button
			type="button"
			className={styles.libraryRow}
			disabled={busy}
			onClick={() => {
				setBusy(true);
				setError(null);
				void onAction()
					.then((result) => {
						if (result && !result.ok) setError(result.message);
					})
					.catch((cause: unknown) =>
						setError(cause instanceof Error ? cause.message : String(cause)),
					)
					.finally(() => setBusy(false));
			}}
		>
			{icon}
			<span className={styles.rowLabels}>
				<span className={styles.rowName}>{busy ? busyLabel : label}</span>
				<span
					className={error ? styles.rowError : styles.rowSubtitle}
					role={error ? "alert" : undefined}
				>
					{error ?? hint}
				</span>
			</span>
		</button>
	);
};
