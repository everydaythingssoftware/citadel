import { useState } from "react";
import type { BookFile } from "@/bindings";
import { GlyphDownload, GlyphOpenExternal } from "@/components/icons/RowGlyphs";
import { Tooltip } from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { type BookFormatRow, bookFormatRows } from "@/lib/book-downloads";
import { usePlatform } from "@/lib/platform/context";
import styles from "./BookActions.module.css";

interface BookActionsProps {
	files: BookFile[];
	isRead: boolean;
	onReadChange: (isRead: boolean) => void;
}

/**
 * What you do with a book rather than what you edit about it: mark it
 * finished, and get at its files.
 */
export const BookActions = ({
	files,
	isRead,
	onReadChange,
}: BookActionsProps) => {
	const rows = bookFormatRows(files);
	return (
		<div className={styles.actions}>
			<FinishedButton isRead={isRead} onReadChange={onReadChange} />
			{rows.length === 0 ? (
				<p className={styles.note}>No files</p>
			) : (
				<FileTiles rows={rows} />
			)}
		</div>
	);
};

/**
 * One button that says what it will do until it's done, then shows the done
 * state: the circle fills, the check draws in, and it stays green. Pressing
 * it again marks the book unread.
 */
const FinishedButton = ({
	isRead,
	onReadChange,
}: Pick<BookActionsProps, "isRead" | "onReadChange">) => {
	// Only a press animates; opening an already-finished book doesn't.
	const [justFinished, setJustFinished] = useState(false);
	return (
		<button
			type="button"
			className={styles.finished}
			aria-pressed={isRead}
			data-just-finished={justFinished || undefined}
			title={isRead ? "Mark as unread" : undefined}
			onAnimationEnd={(event) => {
				// The glow on the button itself runs longest; the circle's and
				// the check's own animations bubble up here too.
				if (event.target === event.currentTarget) setJustFinished(false);
			}}
			onClick={() => {
				setJustFinished(!isRead);
				onReadChange(!isRead);
			}}
		>
			<svg
				className={styles.mark}
				width="16"
				height="16"
				viewBox="0 0 16 16"
				aria-hidden="true"
			>
				<circle className={styles.markCircle} cx="8" cy="8" r="6.75" />
				<path className={styles.markCheck} d="M5 8.25 7.1 10.3 11 6" />
			</svg>
			{isRead ? "Finished" : "Mark as Finished"}
		</button>
	);
};

const verb = (row: BookFormatRow) =>
	row.kind === "download" ? "Download" : "Open";

/**
 * The book's files as small document tiles, the way Finder shows a file:
 * the format printed on the page. Clicking one opens it in its default app
 * (desktop) or downloads it (web); they wrap however many there are.
 */
export const FileTiles = ({ rows }: { rows: BookFormatRow[] }) => {
	const platform = usePlatform();
	const use = (row: BookFormatRow) => {
		if (row.kind === "open") {
			safeAsyncEventHandler(() => platform.fileOpener.openPath(row.path))();
			return;
		}
		const link = document.createElement("a");
		link.href = row.url;
		link.download = "";
		link.click();
	};
	return (
		<ul className={styles.tiles} aria-label="Files">
			{rows.map((row) => {
				const action = `${verb(row)} ${row.label}`;
				return (
					<li key={row.key}>
						<Tooltip label={action}>
							<button
								type="button"
								className={styles.tile}
								aria-label={action}
								onClick={() => use(row)}
							>
								<svg
									className={styles.page}
									viewBox="0 0 40 50"
									aria-hidden="true"
								>
									<path
										className={styles.paper}
										d="M4.5 2.5h22l9 9v34a2 2 0 0 1-2 2h-29a2 2 0 0 1-2-2v-41a2 2 0 0 1 2-2Z"
									/>
									<path
										className={styles.fold}
										d="M26.5 2.5v7a2 2 0 0 0 2 2h7"
									/>
								</svg>
								<span className={styles.format}>{row.label}</span>
								<span className={styles.badge} aria-hidden="true">
									{row.kind === "download" ? (
										<GlyphDownload />
									) : (
										<GlyphOpenExternal />
									)}
								</span>
							</button>
						</Tooltip>
					</li>
				);
			})}
		</ul>
	);
};
