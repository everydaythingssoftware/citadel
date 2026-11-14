import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useMemo,
} from "react";
import type { BookFile } from "@/bindings";
import { safeAsyncEventHandler } from "@/lib/async";
import {
	type BookFileRowView,
	FILE_COMMAND,
	type FileCommand,
	fileMenuEntries,
	fileRowLayout,
	spaceMeansQuickLook,
} from "@/lib/book-file-actions";
import {
	type BookFormatRow,
	bookFileName,
	bookFormatRows,
} from "@/lib/book-downloads";
import type { ContextMenuEntry } from "@/lib/context-menu";
import { useMediaQuery } from "@/lib/hooks/use-breakpoint";
import { useContextMenu } from "@/lib/hooks/use-context-menu";
import { useDefaultApps } from "@/lib/hooks/use-default-apps";
import { useFileDownloads } from "@/lib/hooks/use-file-download";
import { useRemoteFileSizes } from "@/lib/hooks/use-remote-file-sizes";
import { usePlatform } from "@/lib/platform/context";

/** Phones and tablets: no hover, so the whole row is the download button. */
export const COMPACT_FILE_ROWS_QUERY = "(pointer: coarse), (max-width: 36em)";

/**
 * Everything the drawer's Files section does: the rows to show, what each
 * action runs on this platform, the right-click menu, and Quick Look on
 * Space (desktop macOS).
 */
export const useBookFiles = (files: BookFile[]) => {
	const platform = usePlatform();
	const compact = useMediaQuery(COMPACT_FILE_ROWS_QUERY);
	const formatRows = useMemo(() => bookFormatRows(files), [files]);
	const localPaths = useMemo(
		() => formatRows.flatMap((row) => (row.kind === "open" ? [row.path] : [])),
		[formatRows],
	);
	const remoteUrls = useMemo(
		() =>
			compact
				? formatRows.flatMap((row) =>
						row.kind === "download" ? [row.url] : [],
					)
				: [],
		[formatRows, compact],
	);
	const defaultApps = useDefaultApps(localPaths);
	const sizes = useRemoteFileSizes(remoteUrls);
	const downloads = useFileDownloads();
	const contextMenu = useContextMenu();
	const { capabilities, fileOpener, clipboard } = platform;

	const rows = useMemo(
		(): BookFileRowView[] =>
			formatRows.map((row) => ({
				key: row.key,
				format: row.label,
				fileName: bookFileName(row),
				layout: fileRowLayout(row, { compact }),
				path: row.kind === "open" ? row.path : undefined,
				defaultApp: row.kind === "open" ? defaultApps[row.path] : undefined,
				download: downloads.stateOf(row.key),
				size: row.kind === "download" ? (sizes[row.url] ?? null) : null,
			})),
		[formatRows, compact, defaultApps, downloads, sizes],
	);

	const run = useCallback(
		(row: BookFormatRow, command: FileCommand) => {
			const act = (action: () => Promise<unknown>) =>
				safeAsyncEventHandler(action)();
			switch (command) {
				case FILE_COMMAND.open:
					if (row.kind === "open") act(() => fileOpener.openPath(row.path));
					return;
				case FILE_COMMAND.quickLook:
					if (row.kind === "open") act(() => fileOpener.quickLook(row.path));
					return;
				case FILE_COMMAND.reveal:
					if (row.kind === "open")
						act(() => fileOpener.revealInFileManager(row.path));
					return;
				case FILE_COMMAND.copyPath:
					if (row.kind === "open") act(() => clipboard.writeText(row.path));
					return;
				case FILE_COMMAND.copyLink:
					if (row.kind === "download") act(() => clipboard.writeText(row.url));
					return;
				case FILE_COMMAND.download:
					if (row.kind === "download")
						downloads.start(row.key, row.url, bookFileName(row));
					return;
			}
		},
		[fileOpener, clipboard, downloads],
	);

	const rowFor = useCallback(
		(key: string) => formatRows.find((row) => row.key === key),
		[formatRows],
	);

	const onCommand = useCallback(
		(key: string, command: FileCommand) => {
			const row = rowFor(key);
			if (row) run(row, command);
		},
		[rowFor, run],
	);

	const onContextMenu = useCallback(
		(event: MouseEvent, key: string) => {
			const row = rowFor(key);
			if (!row) return;
			const layout = fileRowLayout(row, { compact });
			const items = fileMenuEntries({
				layout,
				label: row.label,
				defaultApp: row.kind === "open" ? defaultApps[row.path] : null,
				fileManagerName: fileOpener.fileManagerName,
				canQuickLook: capabilities.canQuickLook,
				canReveal: capabilities.canRevealInFileManager,
				canCopy: capabilities.canCopyToClipboard,
			}).map(
				(entry): ContextMenuEntry =>
					entry.type === "separator"
						? entry
						: {
								id: entry.command,
								label: entry.label,
								onSelect: () => run(row, entry.command),
							},
			);
			contextMenu.openAt(event, items, `${row.label} file actions`);
		},
		[rowFor, compact, defaultApps, fileOpener, capabilities, run, contextMenu],
	);

	/** Space on a file row, or on the drawer itself, shows it in Quick Look. */
	const onKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key !== " " || event.repeat || !capabilities.canQuickLook)
				return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			if (
				!spaceMeansQuickLook({
					tagName: target.tagName,
					isContentEditable: target.isContentEditable,
					role: target.getAttribute("role"),
				})
			)
				return;
			const path =
				target.closest<HTMLElement>("[data-file-path]")?.dataset.filePath ??
				localPaths[0];
			if (path === undefined) return;
			event.preventDefault();
			safeAsyncEventHandler(() => fileOpener.quickLook(path))();
		},
		[capabilities.canQuickLook, localPaths, fileOpener],
	);

	return {
		rows,
		onCommand,
		onCancelDownload: downloads.cancel,
		onContextMenu,
		onKeyDown,
		contextMenu,
	};
};
