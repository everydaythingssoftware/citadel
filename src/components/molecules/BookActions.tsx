import { useRef, useState } from "react";
import type { BookFile } from "@/bindings";
import { GlyphDownload, GlyphOpenExternal } from "@/components/icons/RowGlyphs";
import {
	ContextMenu,
	type ContextMenuState,
	SegmentedControl,
} from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import { type BookFormatRow, bookFormatRows } from "@/lib/book-downloads";
import { usePlatform } from "@/lib/platform/context";
import styles from "./BookActions.module.css";

interface BookActionsProps {
	files: BookFile[];
	isRead: boolean;
	onReadChange: (isRead: boolean) => void;
}

const ReadState = {
	unread: "unread",
	finished: "finished",
} as const;

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
			<SegmentedControl
				aria-label="Reading state"
				className={styles.readState}
				value={isRead ? ReadState.finished : ReadState.unread}
				onChange={(value) => onReadChange(value === ReadState.finished)}
				items={[
					{ value: ReadState.unread, label: "Unread" },
					{ value: ReadState.finished, label: "Finished" },
				]}
			/>
			{rows.length === 0 ? (
				<p className={styles.note}>No files</p>
			) : (
				<FilesButton rows={rows} />
			)}
		</div>
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
						aria-label="Other formats"
						aria-haspopup="menu"
						aria-expanded={menu !== null}
						onClick={openMenu}
					>
						<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
							<path
								d="M2 3.5 5 6.5 8 3.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				)}
			</div>
			{rest.length > 0 && (
				<p className={styles.note}>
					{rest.length === 1
						? `${rest[0]?.label} in the menu`
						: `${rest.length} more formats in the menu`}
				</p>
			)}
			<ContextMenu
				menu={menu}
				returnFocusRef={moreRef}
				onClose={() => setMenu(null)}
			/>
		</>
	);
};
