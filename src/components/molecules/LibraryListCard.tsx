import { useState } from "react";
import { F7BookFill } from "@/components/icons/F7BookFill";
import { TextInput } from "@/components/ui";
import { useLibraryStats } from "@/lib/hooks/use-library-stats";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { renameLibrary } from "@/stores/settings/actions";
import styles from "./LibraryListCard.module.css";

interface LibraryListCardProps {
	currentLibraryId: string;
	libraries: LibraryPath[];
	onSwitchLibrary: (id: string) => Promise<void>;
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
 * a row switches (the parent validates first); double-clicking the name enters
 * a Finder-style inline rename.
 */
export const LibraryListCard = ({
	currentLibraryId,
	libraries,
	onSwitchLibrary,
}: LibraryListCardProps) => {
	return (
		<div>
			<h4 className={styles.cardTitle}>Libraries</h4>
			<div className={styles.card}>
				{libraries.map((library) => (
					<LibraryRow
						key={library.id}
						library={library}
						isActive={library.id === currentLibraryId}
						onSwitchLibrary={onSwitchLibrary}
					/>
				))}
			</div>
		</div>
	);
};

interface LibraryRowProps {
	library: LibraryPath;
	isActive: boolean;
	onSwitchLibrary: (id: string) => Promise<void>;
}

const LibraryRow = ({
	library,
	isActive,
	onSwitchLibrary,
}: LibraryRowProps) => {
	const stats = useLibraryStats(library.absolutePath);
	const [isRenaming, setIsRenaming] = useState(false);
	const [draftName, setDraftName] = useState(library.displayName);
	const [renameError, setRenameError] = useState<string | null>(null);

	const commitRename = async () => {
		try {
			await renameLibrary(library.id, draftName);
			setIsRenaming(false);
		} catch (e) {
			setRenameError(e instanceof Error ? e.message : String(e));
		}
	};

	const startRenaming = () => {
		setDraftName(library.displayName);
		setRenameError(null);
		setIsRenaming(true);
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
						value={draftName}
						error={renameError}
						aria-label={`Library name for ${library.displayName}`}
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
				</div>
			</div>
		);
	}

	return (
		<button
			type="button"
			className={styles.libraryRow}
			onClick={() => {
				if (!isActive) void onSwitchLibrary(library.id);
			}}
		>
			<F7BookFill className={styles.rowIcon} aria-hidden="true" />
			<span className={styles.rowLabels}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Finder-style double-click rename lives on the name itself; keyboard users rename via the Current Library card's Name field. */}
				<span className={styles.rowName} onDoubleClick={startRenaming}>
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
