import type { ReactNode } from "react";
import { useAddBook } from "@/components/organisms/AddBook";
import { Button } from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { abbreviateHomePath, useHomeDir } from "@/lib/hooks/use-home-dir";
import { useOpenSettings } from "@/lib/hooks/use-open-settings";
import { usePlatform } from "@/lib/platform/context";
import { useActiveLibraryPath } from "@/stores/settings/store";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
	/** Short heading naming what's empty or unmatched. */
	title: string;
	/** Optional soft explanatory line under the title. */
	description?: ReactNode;
	/** Action buttons, rendered in a centered row beneath the copy. */
	children?: ReactNode;
}

/**
 * Quiet, illustration-free placeholder for empty grids/lists and zero-result
 * filters (DESIGN.md: neutral chrome, no empty-state art). Fills the height of
 * its scroll container and centers a heading, optional description, and an
 * action row.
 */
export const EmptyState = ({
	title,
	description,
	children,
}: EmptyStateProps) => {
	return (
		<div className={styles.root}>
			<div className={styles.inner}>
				<h2 className={styles.title}>{title}</h2>
				{description !== undefined && (
					<p className={styles.description}>{description}</p>
				)}
				{children !== undefined && (
					<div className={styles.actions}>{children}</div>
				)}
			</div>
		</div>
	);
};

/**
 * First-run / empty-library teaching state (CDL-11, extended by CDL-19).
 * Names where the library lives (with the copy-on-import fact) and the ways
 * to populate it. Shared by the Books and Authors pages, and the landing
 * state after creating a new library in the first-run flow.
 */
export const EmptyLibrary = () => {
	const { startAddBook, canAddBook } = useAddBook();
	const openSettings = useOpenSettings();
	const platform = usePlatform();
	const home = useHomeDir();
	const libraryPath = useActiveLibraryPath();
	const path = libraryPath.isSome ? libraryPath.value : null;

	return (
		<EmptyState
			title="Your library is empty"
			description={
				path !== null
					? `Books you add are copied into your library at ${abbreviateHomePath(path, home)}.`
					: canAddBook
						? "Add a book to this library, or switch to an existing Calibre library."
						: "Switch to an existing Calibre library to get started."
			}
		>
			{canAddBook && (
				<Button variant="primary" onClick={startAddBook}>
					Add Book…
				</Button>
			)}
			{path !== null && platform.capabilities.canRevealInFileManager && (
				<Button
					variant="default"
					onClick={safeAsyncEventHandler(async () => {
						await platform.fileOpener.revealInFileManager(path);
					})}
				>
					Show in Finder
				</Button>
			)}
			<Button variant="subtle" onClick={openSettings}>
				Switch library…
			</Button>
		</EmptyState>
	);
};
