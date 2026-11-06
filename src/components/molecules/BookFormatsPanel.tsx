import { useState } from "react";
import type { BookFile } from "@/bindings";
import { GlyphDownload, GlyphOpenExternal } from "@/components/icons/RowGlyphs";
import { safeAsyncEventHandler } from "@/lib/async";
import { type BookFormatRow, bookFormatRows } from "@/lib/book-downloads";
import { usePlatform } from "@/lib/platform/context";
import styles from "./BookFormatsPanel.module.css";

/** Rows shown before the rest fold behind "Show N more". */
const VISIBLE_ROWS = 7;

interface BookFormatsPanelProps {
	files: BookFile[];
}

/**
 * A book's files as a grouped panel: each row is one button or link, opening
 * the file in its default app on the desktop or downloading it on the web.
 */
export const BookFormatsPanel = ({ files }: BookFormatsPanelProps) => {
	const rows = bookFormatRows(files);
	const [expanded, setExpanded] = useState(false);
	const folded = !expanded && rows.length > VISIBLE_ROWS + 1;
	const shown = folded ? rows.slice(0, VISIBLE_ROWS) : rows;

	return (
		<section className={styles.panel} aria-labelledby="book-formats-heading">
			<div className={styles.head}>
				<span id="book-formats-heading">
					{rows.length === 1 ? "Format" : "Formats"}
				</span>
				{rows.length > 1 && <span>{rows.length}</span>}
			</div>
			{rows.length === 0 ? (
				<p className={styles.none}>No files</p>
			) : (
				<ul className={styles.rows}>
					{shown.map((row) => (
						<li key={row.key}>
							<FormatRow row={row} />
						</li>
					))}
					{folded && (
						<li>
							<button
								type="button"
								className={styles.row}
								onClick={() => setExpanded(true)}
							>
								<span className={styles.more}>
									Show {rows.length - VISIBLE_ROWS} more
								</span>
							</button>
						</li>
					)}
				</ul>
			)}
		</section>
	);
};

const FormatRow = ({ row }: { row: BookFormatRow }) => {
	const platform = usePlatform();
	if (row.kind === "download") {
		return (
			<a
				className={styles.row}
				href={row.url}
				download
				aria-label={`Download ${row.label}`}
			>
				<span className={styles.name}>{row.label}</span>
				<GlyphDownload className={styles.glyph} />
			</a>
		);
	}
	return (
		<button
			type="button"
			className={styles.row}
			aria-label={`Open ${row.label} in its default app`}
			onClick={safeAsyncEventHandler(() =>
				platform.fileOpener.openPath(row.path),
			)}
		>
			<span className={styles.name}>{row.label}</span>
			<GlyphOpenExternal className={styles.glyph} />
		</button>
	);
};
