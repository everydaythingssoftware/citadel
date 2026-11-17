import clsx from "clsx";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { DownloadRing } from "@/components/atoms/DownloadRing";
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
	downloadButtonAccessibleLabel,
	downloadButtonLabel,
	FILE_COMMAND,
	FILE_ROW_LAYOUT,
	type FileCommand,
	mobileRowDetail,
	mobileRowLabel,
	openLabel,
} from "@/lib/book-file-actions";
import {
	downloadFraction,
	type FileDownloadState,
	formatByteSize,
} from "@/lib/file-download";
import { none, type Option, some } from "@/lib/option";
import type { OperatingSystem } from "@/lib/platform/os";
import type { DefaultApp } from "@/lib/platform/types";
import styles from "./BookFileList.module.css";

interface RowHandlers {
	onCommand: (key: string, command: FileCommand) => void;
	onCancelDownload: (key: string) => void;
}

export interface BookFileListProps extends RowHandlers {
	rows: BookFileRowView[];
	os: OperatingSystem;
	onContextMenu: (event: MouseEvent, key: string) => void;
	onRowKeyDown: (event: KeyboardEvent, key: string) => void;
}

type RowOf<TLayout extends BookFileRowView["layout"]> = Extract<
	BookFileRowView,
	{ layout: TLayout }
>;

/**
 * A book's files as one rounded group, a row per format: its document
 * icon, the format in bold and the filename shortened in the middle. What
 * the row offers depends on where Citadel runs: Show in Finder and Open on
 * the desktop, a download button in a browser, the whole row on a phone.
 */
export const BookFileList = ({
	rows,
	os,
	onCommand,
	onCancelDownload,
	onContextMenu,
	onRowKeyDown,
}: BookFileListProps) => (
	<ul className={styles.group} aria-label="Files">
		{rows.map((row) => {
			if (row.layout === FILE_ROW_LAYOUT.mobile)
				return (
					<MobileRow
						key={row.key}
						row={row}
						onCommand={onCommand}
						onCancelDownload={onCancelDownload}
					/>
				);
			const desktop = row.layout === FILE_ROW_LAYOUT.desktop;
			return (
				<li
					key={row.key}
					className={styles.row}
					data-layout={row.layout}
					tabIndex={desktop ? 0 : undefined}
					aria-label={`${row.format}, ${row.fileName}`}
					onContextMenu={(event) => onContextMenu(event, row.key)}
					onKeyDown={(event) => onRowKeyDown(event, row.key)}
					onDoubleClick={
						desktop ? () => onCommand(row.key, FILE_COMMAND.open) : undefined
					}
				>
					<FileTypeIcon format={row.format} />
					<RowText
						row={row}
						failure={desktop ? none() : failureOf(row.download)}
					/>
					<span className={styles.buttons}>
						{desktop ? (
							<DesktopButtons row={row} os={os} onCommand={onCommand} />
						) : (
							<WebDownloadButton
								row={row}
								onCommand={onCommand}
								onCancelDownload={onCancelDownload}
							/>
						)}
					</span>
				</li>
			);
		})}
	</ul>
);

const failureOf = (download: FileDownloadState): Option<string> =>
	download.status === "failed" ? some(download.message) : none();

const RowText = ({
	row,
	failure,
}: {
	row: BookFileRowView;
	failure: Option<string>;
}) => (
	<span className={styles.text}>
		<span className={styles.format}>{row.format}</span>
		{failure.isSome ? (
			<span className={styles.failure}>{failure.value}</span>
		) : (
			<MiddleTruncatedText className={styles.name} text={row.fileName} />
		)}
	</span>
);

const DesktopButtons = ({
	row,
	os,
	onCommand,
}: {
	row: RowOf<"desktop">;
	os: OperatingSystem;
	onCommand: RowHandlers["onCommand"];
}) => (
	<>
		{row.reveal.isSome && (
			<IconAction
				label={row.reveal.value}
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
	</>
);

const OpenIcon = ({
	os,
	app,
}: {
	os: OperatingSystem;
	app: Option<Option<DefaultApp>>;
}) => {
	// Holds the place while the desktop looks the app up, so the row
	// doesn't flash a generic icon first.
	if (!app.isSome) return <span className={styles.appIcon} />;
	if (app.value.isSome)
		return (
			<img
				className={styles.appIcon}
				src={app.value.value.iconDataUrl}
				alt=""
			/>
		);
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
			// A double-click on a button is two presses, not "open the row".
			onDoubleClick={(event) => event.stopPropagation()}
		>
			{children}
		</button>
	</Tooltip>
);

const WebDownloadButton = ({
	row,
	onCommand,
	onCancelDownload,
}: RowHandlers & { row: RowOf<"web"> }) => {
	const { download } = row;
	const label = downloadButtonLabel(row.format, download);
	if (download.status === "downloading")
		return (
			<Tooltip label={label} openDelay={400}>
				<button
					type="button"
					className={styles.iconButton}
					data-download="downloading"
					aria-label={downloadButtonAccessibleLabel(row.format, download)}
					onClick={() => onCancelDownload(row.key)}
				>
					<DownloadRing state={download} />
					<DownloadRing className={styles.stopRing} state={download} showStop />
				</button>
			</Tooltip>
		);
	return (
		<IconAction
			label={label}
			onClick={() => onCommand(row.key, FILE_COMMAND.download)}
		>
			{download.status === "failed" ? (
				<RetryGlyph />
			) : (
				<DownloadRing state={download} />
			)}
		</IconAction>
	);
};

const MobileRow = ({
	row,
	onCommand,
	onCancelDownload,
}: RowHandlers & { row: RowOf<"mobile"> }) => {
	const { download } = row;
	const downloading = download.status === "downloading";
	const detail = mobileRowDetail(download);
	const fraction = downloadFraction(download);
	return (
		<li className={styles.mobileItem}>
			<button
				type="button"
				className={clsx(styles.row, styles.mobileRow)}
				data-layout={row.layout}
				data-download={download.status}
				aria-label={mobileRowLabel(row)}
				onClick={() =>
					downloading
						? onCancelDownload(row.key)
						: onCommand(row.key, FILE_COMMAND.download)
				}
			>
				<FileTypeIcon format={row.format} width={30} height={36} />
				<span className={styles.text}>
					<span className={styles.format}>{row.format}</span>
					{detail.isSome ? (
						<span
							className={
								download.status === "failed" ? styles.failure : styles.name
							}
						>
							{detail.value}
						</span>
					) : (
						<MiddleTruncatedText className={styles.name} text={row.fileName} />
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
				{row.size.isSome && !downloading && (
					<span className={styles.size}>{formatByteSize(row.size.value)}</span>
				)}
				<span className={styles.mobileGlyph}>
					{download.status === "failed" ? (
						<RetryGlyph width={20} height={20} />
					) : (
						<DownloadRing state={download} showStop size={22} />
					)}
				</span>
			</button>
		</li>
	);
};
