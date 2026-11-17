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
	/** The drawing above the title: a shelf, or a search that found a gap. */
	art?: "shelf" | "search";
}

/* Line drawings in the ink colour, so they sit quietly in either theme. */
const ShelfArt = () => (
	<svg
		width="36"
		height="36"
		viewBox="0 0 36 36"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M6 7.5h6.5v21H6zM14.5 7.5H21v21h-6.5z" />
		<path d="m23.2 9.4 6.1-1.6 5.2 19.6-6 1.6z" />
	</svg>
);

/* A shelf with one book missing, and a magnifying glass peering into the gap. */
const SearchArt = () => (
	<svg
		width="64"
		height="44"
		viewBox="0 0 64 44"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M4 40h48" />
		<path d="M8 12h7v28H8zM17 8h7v32h-7z" />
		<path d="M26 14h7v26h-7z" strokeDasharray="2.5 2.5" opacity="0.7" />
		<path d="M35 10h7v30h-7z" />
		<circle cx="45" cy="20" r="9" fill="var(--ctd-content-bg)" />
		<path d="m51.5 26.5 7 7" strokeWidth="2.5" />
		<path d="M42.5 17.5a3.5 3.5 0 0 1 4.5-1" opacity="0.6" />
	</svg>
);

/**
 * Quiet placeholder for empty grids/lists and zero-result
 * filters, marked by a faint line-drawn shelf (DESIGN.md: neutral chrome). Fills the height of
 * its scroll container and centers a heading, optional description, and an
 * action row.
 */
export const EmptyState = ({
	title,
	description,
	children,
	art = "shelf",
}: EmptyStateProps) => {
	return (
		<div className={styles.root}>
			<div className={styles.inner}>
				<span className={styles.mark}>
					{art === "search" ? <SearchArt /> : <ShelfArt />}
				</span>
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
					Show in {platform.fileOpener.fileManagerName}
				</Button>
			)}
			<Button variant="subtle" onClick={openSettings}>
				Switch library…
			</Button>
		</EmptyState>
	);
};
