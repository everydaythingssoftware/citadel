import { useRef, useState } from "react";
import type { BookFile } from "@/bindings";
import { GlyphDownload, GlyphOpenExternal } from "@/components/icons/RowGlyphs";
import { ContextMenu, type ContextMenuState } from "@/components/ui";
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
 * finished, and get at its files. One file is one button; more add a menu.
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
				<FilesButton rows={rows} />
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

const FilesButton = ({ rows }: { rows: BookFormatRow[] }) => {
	const platform = usePlatform();
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const moreRef = useRef<HTMLButtonElement>(null);
	const [first, ...rest] = rows;
	if (!first) return null;

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

	const openMenu = () => {
		const rect = moreRef.current?.getBoundingClientRect();
		if (!rect) return;
		setMenu({
			x: rect.right - 160,
			y: rect.bottom + 4,
			items: rows.map((row) => ({
				id: row.key,
				label: `${verb(row)} ${row.label}`,
				onSelect: () => use(row),
			})),
		});
	};

	const Glyph = first.kind === "download" ? GlyphDownload : GlyphOpenExternal;
	return (
		<>
			<div className={styles.split}>
				<button
					type="button"
					className={styles.main}
					onClick={() => use(first)}
				>
					<Glyph className={styles.glyph} />
					{verb(first)} {first.label}
				</button>
				{rest.length > 0 && (
					<button
						ref={moreRef}
						type="button"
						className={styles.more}
						aria-label={`Other formats (${rest.length})`}
						aria-haspopup="menu"
						aria-expanded={menu !== null}
						onClick={openMenu}
					>
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
							<path
								d="M2.5 4.5 6 8l3.5-3.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				)}
			</div>
			<ContextMenu
				menu={menu}
				returnFocusRef={moreRef}
				onClose={() => setMenu(null)}
			/>
		</>
	);
};
