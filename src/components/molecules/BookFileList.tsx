import clsx from "clsx";
import type { MouseEvent, ReactNode } from "react";
import {
	DownloadRing,
	type DownloadRingState,
} from "@/components/atoms/DownloadRing";
import { MiddleTruncatedText } from "@/components/atoms/MiddleTruncatedText";
import {
	MacFolderGlyph,
	MacOpenBookGlyph,
	RetryGlyph,
	TablerFolderGlyph,
	TablerOpenBookGlyph,
} from "@/components/icons/FileActionGlyphs";
import { FileTypeIcon } from "@/components/icons/FileTypeIcon";
import { Tooltip } from "@/components/ui";
import {
	type BookFileRowView,
	type DefaultApp,
	FILE_COMMAND,
	FILE_ROW_LAYOUT,
	type FileCommand,
	openLabel,
	revealLabel,
} from "@/lib/book-file-actions";
import {
	downloadFraction,
	downloadProgressText,
	type FileDownloadState,
	formatByteSize,
} from "@/lib/file-download";
import type { OperatingSystem } from "@/lib/platform/os";
import styles from "./BookFileList.module.css";

export interface BookFileListProps {
	rows: BookFileRowView[];
	os: OperatingSystem;
	fileManagerName: string;
	canReveal: boolean;
	onCommand: (key: string, command: FileCommand) => void;
	onCancelDownload: (key: string) => void;
	onContextMenu: (event: MouseEvent, key: string) => void;
}

/**
 * A book's files as one rounded group, a row per format: its document
 * icon, the format in bold and the filename shortened in the middle. What
 * the row offers depends on where Citadel runs: Show in Finder and Open on
 * the desktop, a download button in a browser, the whole row on a phone.
 */
export const BookFileList = ({
	rows,
	os,
	fileManagerName,
	canReveal,
	onCommand,
	onCancelDownload,
	onContextMenu,
}: BookFileListProps) => (
	<ul className={styles.group} aria-label="Files">
		{rows.map((row) =>
			row.layout === FILE_ROW_LAYOUT.mobile ? (
				<MobileRow
					key={row.key}
					row={row}
					onCommand={onCommand}
					onCancelDownload={onCancelDownload}
				/>
			) : (
				<li
					key={row.key}
					className={styles.row}
					data-layout={row.layout}
					data-file-path={row.path}
					tabIndex={row.layout === FILE_ROW_LAYOUT.desktop ? 0 : undefined}
					aria-label={`${row.format}, ${row.fileName}`}
					onContextMenu={(event) => onContextMenu(event, row.key)}
					onDoubleClick={(event) => {
						if (row.layout === FILE_ROW_LAYOUT.desktop && !isControl(event))
							onCommand(row.key, FILE_COMMAND.open);
					}}
				>
					<FileTypeIcon format={row.format} />
					<RowText row={row} />
					{row.layout === FILE_ROW_LAYOUT.desktop ? (
						<span className={styles.buttons}>
							{canReveal && (
								<IconAction
									label={revealLabel(fileManagerName)}
									onClick={() => onCommand(row.key, FILE_COMMAND.reveal)}
								>
									{os === "macos" ? <MacFolderGlyph /> : <TablerFolderGlyph />}
								</IconAction>
							)}
							<IconAction
								label={openLabel(row.defaultApp)}
								onClick={() => onCommand(row.key, FILE_COMMAND.open)}
							>
								<OpenIcon os={os} app={row.defaultApp} />
							</IconAction>
						</span>
					) : (
						<span className={styles.buttons}>
							<WebDownloadButton
								row={row}
								onCommand={onCommand}
								onCancelDownload={onCancelDownload}
							/>
						</span>
					)}
				</li>
			),
		)}
	</ul>
);

const isControl = (event: MouseEvent) =>
	event.target instanceof Element && event.target.closest("button") !== null;

const RowText = ({ row }: { row: BookFileRowView }) => (
	<span className={styles.text}>
		<span className={styles.format}>{row.format}</span>
		{row.download.status === "failed" ? (
			<span className={styles.failure}>{row.download.message}</span>
		) : (
			<MiddleTruncatedText className={styles.name} text={row.fileName} />
		)}
	</span>
);

const OpenIcon = ({
	os,
	app,
}: {
	os: OperatingSystem;
	app: DefaultApp | null | undefined;
}) => {
	if (app)
		return <img className={styles.appIcon} src={app.iconDataUrl} alt="" />;
	// Holds the place while the desktop looks the app up, so the row
	// doesn't flash a generic icon first.
	if (app === undefined) return <span className={styles.appIcon} />;
	return os === "macos" ? <MacOpenBookGlyph /> : <TablerOpenBookGlyph />;
};

const IconAction = ({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) => (
	<Tooltip label={label} openDelay={400}>
		<button
			type="button"
			className={styles.iconButton}
			aria-label={label}
			onClick={onClick}
		>
			{children}
		</button>
	</Tooltip>
);

const ringState = (download: FileDownloadState): DownloadRingState => {
	switch (download.status) {
		case "downloading":
			return { status: "downloading", progress: downloadFraction(download) };
		case "done":
			return { status: "done" };
		default:
			return { status: "idle" };
	}
};

const percentOf = (download: FileDownloadState) => {
	const fraction = downloadFraction(download);
	return fraction === null ? "" : `, ${Math.round(fraction * 100)}%`;
};

const WebDownloadButton = ({
	row,
	onCommand,
	onCancelDownload,
}: {
	row: BookFileRowView;
	onCommand: BookFileListProps["onCommand"];
	onCancelDownload: BookFileListProps["onCancelDownload"];
}) => {
	const { download } = row;
	if (download.status === "downloading") {
		const label = `Stop Downloading ${row.format}`;
		return (
			<Tooltip label={label} openDelay={400}>
				<button
					type="button"
					className={styles.iconButton}
					data-download="downloading"
					aria-label={`${label}${percentOf(download)}`}
					onClick={() => onCancelDownload(row.key)}
				>
					<DownloadRing state={ringState(download)} />
					<DownloadRing
						className={styles.stopRing}
						state={ringState(download)}
						showStop
					/>
				</button>
			</Tooltip>
		);
	}
	const label =
		download.status === "failed"
			? `Try Downloading ${row.format} Again`
			: download.status === "done"
				? `Download ${row.format} Again`
				: `Download ${row.format}`;
	return (
		<IconAction
			label={label}
			onClick={() => onCommand(row.key, FILE_COMMAND.download)}
		>
			{download.status === "failed" ? (
				<RetryGlyph />
			) : (
				<DownloadRing state={ringState(download)} />
			)}
		</IconAction>
	);
};

/** "2.1 MB", "Downloading… 3.9 of 8.4 MB", "Downloaded", "Tap to try again". */
const mobileDetail = (row: BookFileRowView): string | null => {
	const { download } = row;
	switch (download.status) {
		case "downloading":
			return `Downloading… ${downloadProgressText(download.received, download.total)}`;
		case "failed":
			return `${download.message}. Tap to try again.`;
		default:
			return null;
	}
};

const MobileRow = ({
	row,
	onCommand,
	onCancelDownload,
}: {
	row: BookFileRowView;
	onCommand: BookFileListProps["onCommand"];
	onCancelDownload: BookFileListProps["onCancelDownload"];
}) => {
	const { download } = row;
	const downloading = download.status === "downloading";
	const detail = mobileDetail(row);
	const fraction = downloadFraction(download);
	const label = downloading
		? `Stop downloading ${row.format}${percentOf(download)}`
		: `Download ${row.format}, ${row.fileName}${row.size !== null ? `, ${formatByteSize(row.size)}` : ""}`;
	return (
		<li className={styles.mobileItem}>
			<button
				type="button"
				className={clsx(styles.row, styles.mobileRow)}
				data-layout={row.layout}
				data-download={download.status}
				aria-label={label}
				onClick={() =>
					downloading
						? onCancelDownload(row.key)
						: onCommand(row.key, FILE_COMMAND.download)
				}
			>
				<FileTypeIcon format={row.format} width={30} height={36} />
				<span className={styles.text}>
					<span className={styles.format}>{row.format}</span>
					{detail === null ? (
						<MiddleTruncatedText className={styles.name} text={row.fileName} />
					) : (
						<span
							className={
								download.status === "failed" ? styles.failure : styles.name
							}
						>
							{detail}
						</span>
					)}
					{downloading && (
						<span
							className={styles.bar}
							data-indeterminate={fraction === null || undefined}
						>
							<span style={{ width: `${(fraction ?? 0.3) * 100}%` }} />
						</span>
					)}
				</span>
				{row.size !== null && !downloading && (
					<span className={styles.size}>{formatByteSize(row.size)}</span>
				)}
				<span className={styles.mobileGlyph}>
					{download.status === "failed" ? (
						<RetryGlyph width={20} height={20} />
					) : (
						<DownloadRing state={ringState(download)} showStop size={22} />
					)}
				</span>
			</button>
		</li>
	);
};
