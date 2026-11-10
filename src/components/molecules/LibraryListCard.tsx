import { useRef, useState } from "react";
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
import {
	type PendingRemoval,
	removalNeedsConfirmation,
	withPendingRemovals,
} from "@/lib/library-list/pending-removals";
import { usePlatform } from "@/lib/platform/context";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { renameLibrary } from "@/stores/settings/actions";
import styles from "./LibraryListCard.module.css";

interface LibraryListCardProps {
	currentLibraryId: string;
	libraries: LibraryPath[];
	onSwitchLibrary: (id: string) => Promise<void>;
	/** Adds "Remove" to each row's menu when set. */
	onRemoveLibrary?: (library: LibraryPath) => void;
	/** Libraries just removed, shown as "Removed … · Undo" rows in place. */
	pendingRemovals?: readonly PendingRemoval[];
	onUndoRemove?: (id: string) => void;
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
	onRemoveLibrary,
	pendingRemovals = [],
	onUndoRemove,
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
				label: `Show in ${platform.fileOpener.fileManagerName}`,
				onSelect: () => {
					void platform.fileOpener.revealInFileManager(library.absolutePath);
				},
			});
		}
		if (onRemoveLibrary) {
			items.push({
				id: "remove",
				label: removalNeedsConfirmation(libraries.length)
					? "Remove…"
					: "Remove",
				onSelect: () => onRemoveLibrary(library),
			});
		}
		setMenuTargetId(library.id);
		setMenu({ x, y, items });
	};

	const entries = withPendingRemovals(libraries, pendingRemovals);
	// The top row's divider is hidden; while rows above close, the next row
	// takes over, its divider fading as the gap shuts.
	const firstShown = entries.findIndex(
		(entry) => entry.kind === "library" || entry.removal.phase !== "closing",
	);

	const closeMenu = () => {
		setMenu(null);
		setMenuTargetId(null);
	};

	return (
		<div>
			<h4 className={styles.cardTitle}>Libraries</h4>
			<div className={styles.card}>
				{entries.map((entry, index) => {
					const library =
						entry.kind === "library" ? entry.library : entry.removal.library;
					const removal = entry.kind === "removed" ? entry.removal : null;
					const state =
						removal === null
							? "live"
							: removal.phase === "closing"
								? "closing"
								: "placeholder";
					return (
						<div
							key={library.id}
							className={styles.slot}
							data-state={state}
							data-first={index === firstShown || undefined}
						>
							<LibraryRow
								library={library}
								isRemoved={removal !== null}
								isActive={removal === null && library.id === currentLibraryId}
								isMenuTarget={library.id === menuTargetId}
								isRenaming={removal === null && rename?.id === library.id}
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
										current === null
											? current
											: { ...current, draft, error: null },
									)
								}
								onCommitRename={commitRename}
								onCancelRename={cancelRename}
								onOpenMenu={(x, y, anchor) => {
									menuRowRef.current = anchor;
									openMenu(library, x, y);
								}}
							/>
							{removal !== null && state === "placeholder" && (
								<RemovedPlaceholder
									removal={removal}
									onUndo={() => onUndoRemove?.(library.id)}
								/>
							)}
						</div>
					);
				})}
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
	/** Shown behind its placeholder only: inert, and fading as it closes. */
	isRemoved: boolean;
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
	isRemoved,
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
			// A removed row stays mounted behind its placeholder so it can fade
			// in place; it takes no input and is hidden from assistive tech.
			disabled={isRemoved}
			tabIndex={isRemoved ? -1 : undefined}
			aria-hidden={isRemoved || undefined}
			onClick={() => {
				if (!isActive && !isRemoved) void onSwitchLibrary(library.id);
			}}
			onContextMenu={isRemoved ? undefined : openMenuFromPointer}
			onKeyDown={isRemoved ? undefined : openMenuFromKeyboard}
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

const UndoGlyph = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M5.5 3 2.5 6l3 3"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
		<path
			d="M3 6h6.5a4 4 0 0 1 0 8H7"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
		/>
	</svg>
);

/** "Removed “…” · Undo", in the removed row's place for a few seconds. */
const RemovedPlaceholder = ({
	removal,
	onUndo,
}: {
	removal: PendingRemoval;
	onUndo: () => void;
}) => {
	const name = removal.library.displayName;
	return (
		<div className={styles.placeholder} role="status">
			{removal.error ? (
				<span className={styles.placeholderError}>
					Couldn’t undo: {removal.error}
				</span>
			) : (
				<>
					<span className={styles.placeholderText}>Removed “{name}”</span>
					<span className={styles.placeholderNote}>· files kept</span>
				</>
			)}
			<button
				type="button"
				className={styles.undo}
				disabled={removal.phase === "restoring"}
				aria-label={`Undo removing “${name}”`}
				onClick={onUndo}
			>
				<UndoGlyph />
				Undo
			</button>
		</div>
	);
};
