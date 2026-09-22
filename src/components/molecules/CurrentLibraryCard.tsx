import { useEffect, useState } from "react";
import { Button, TextInput } from "@/components/ui";
import { useLibraryStats } from "@/lib/hooks/use-library-stats";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { renameLibrary } from "@/stores/settings/actions";
import styles from "./CurrentLibraryCard.module.css";

interface CurrentLibraryCardProps {
	library: LibraryPath;
	/** Reveal the library folder in the system file manager; null when the platform can't. */
	onRevealInFileManager: (() => void) | null;
}

const plural = (count: number, word: string) =>
	count === 1 ? word : `${word}s`;

/**
 * "Current Library" card: editable name, a Show-in-Finder affordance for the
 * location (never the path as text), and headline contents counts.
 */
export const CurrentLibraryCard = ({
	library,
	onRevealInFileManager,
}: CurrentLibraryCardProps) => {
	const stats = useLibraryStats(library.absolutePath);
	const [draftName, setDraftName] = useState(library.displayName);
	const [nameError, setNameError] = useState<string | null>(null);

	useEffect(() => {
		setDraftName(library.displayName);
		setNameError(null);
	}, [library.displayName]);

	const commitName = async () => {
		try {
			await renameLibrary(library.id, draftName);
			setNameError(null);
		} catch (e) {
			setNameError(e instanceof Error ? e.message : String(e));
		}
	};

	const contents =
		stats.status === "loading"
			? "…"
			: stats.status === "loaded"
				? `${stats.stats.book_count} ${plural(stats.stats.book_count, "book")} · ${stats.stats.author_count} ${plural(stats.stats.author_count, "author")}`
				: null;

	return (
		<div>
			<h4 className={styles.cardTitle}>Current Library</h4>
			<div className={styles.card}>
				<div className={styles.row}>
					<span className={styles.rowLabel}>Name</span>
					<TextInput
						className={styles.nameInput}
						value={draftName}
						error={nameError}
						aria-label="Library name"
						onChange={(event) => {
							setDraftName(event.currentTarget.value);
							setNameError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								void commitName();
							} else if (event.key === "Escape") {
								setDraftName(library.displayName);
								setNameError(null);
							}
						}}
						onBlur={() => void commitName()}
					/>
				</div>
				{onRevealInFileManager !== null && (
					<div className={styles.row}>
						<span className={styles.rowLabel}>Location</span>
						<Button size="sm" variant="default" onClick={onRevealInFileManager}>
							Show in Finder
						</Button>
					</div>
				)}
				{contents !== null && (
					<div className={styles.row}>
						<span className={styles.rowLabel}>Contents</span>
						<span className={styles.rowValue}>{contents}</span>
					</div>
				)}
			</div>
		</div>
	);
};
