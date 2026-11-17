import { type KeyboardEvent, type MouseEvent, useMemo } from "react";
import type { BookFile } from "@/bindings";
import { safeAsyncEventHandler } from "@/lib/async";
import {
	type BookFormatRow,
	bookFileName,
	bookFormatRows,
} from "@/lib/book-downloads";
import {
	type BookFileRowView,
	FILE_COMMAND,
	FILE_ROW_LAYOUT,
	type FileCommand,
	type FileMenuFeatures,
	fileMenuEntries,
	fileRowLayout,
	revealLabel,
	spaceMeansQuickLook,
} from "@/lib/book-file-actions";
import { fetchContentLength } from "@/lib/download";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/use-breakpoint";
import {
	type ContextMenuController,
	useContextMenu,
} from "@/lib/hooks/use-context-menu";
import { useFileDownloads } from "@/lib/hooks/use-file-download";
import { useLookups } from "@/lib/hooks/use-lookups";
import { none, some } from "@/lib/option";
import { usePlatform } from "@/lib/platform/context";

/** Phones and tablets: no hover, so the whole row is the download button. */
const COMPACT_FILE_ROWS_QUERY = `(pointer: coarse), ${PHONE_QUERY}`;

export interface BookFiles {
	rows: BookFileRowView[];
	onCommand: (key: string, command: FileCommand) => void;
	onCancelDownload: (key: string) => void;
	onContextMenu: (event: MouseEvent, key: string) => void;
	/** Space on a file row shows that file in Quick Look. */
	onRowKeyDown: (event: KeyboardEvent, key: string) => void;
	/** Space elsewhere in the drawer shows its first file. */
	onKeyDown: (event: KeyboardEvent) => void;
	contextMenu: ContextMenuController;
}

/**
 * Everything the drawer's Files section does: the rows to show, what each
 * action runs on this platform, the right-click menu, and Quick Look on
 * Space (desktop macOS).
 */
export const useBookFiles = (files: BookFile[]): BookFiles => {
	const { capabilities, fileOpener, clipboard } = usePlatform();
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
	const defaultApp = useLookups(localPaths, fileOpener.defaultApp);
	const size = useLookups(remoteUrls, fetchContentLength);
	const downloads = useFileDownloads();
	const contextMenu = useContextMenu();
	const reveal = capabilities.canRevealInFileManager
		? some(revealLabel(fileOpener.fileManagerName))
		: none<string>();
	const features: FileMenuFeatures = {
		quickLook: fileOpener.quickLook,
		copy: capabilities.canCopyToClipboard
			? some((text: string) => clipboard.writeText(text))
			: none(),
	};

	const viewOf = (row: BookFormatRow): BookFileRowView => {
		const base = {
			key: row.key,
			format: row.label,
			fileName: bookFileName(row),
		};
		if (row.kind === "open")
			return {
				...base,
				layout: FILE_ROW_LAYOUT.desktop,
				defaultApp: defaultApp(row.path),
				reveal,
			};
		const download = downloads.stateOf(row.key);
		if (fileRowLayout(row, { compact }) === FILE_ROW_LAYOUT.web)
			return { ...base, layout: FILE_ROW_LAYOUT.web, download };
		const known = size(row.url);
		return {
			...base,
			layout: FILE_ROW_LAYOUT.mobile,
			download,
			size: known.isSome ? known.value : none(),
		};
	};

	const run = (row: BookFormatRow, command: FileCommand) => {
		const act = (action: () => Promise<unknown>) =>
			safeAsyncEventHandler(action)();
		const { quickLook, copy } = features;
		if (row.kind === "open") {
			if (command === FILE_COMMAND.open)
				act(() => fileOpener.openPath(row.path));
			if (command === FILE_COMMAND.quickLook && quickLook.isSome)
				act(() => quickLook.value(row.path));
			if (command === FILE_COMMAND.reveal)
				act(() => fileOpener.revealInFileManager(row.path));
			if (command === FILE_COMMAND.copyPath && copy.isSome)
				act(() => copy.value(row.path));
			return;
		}
		if (command === FILE_COMMAND.download)
			downloads.start(row.key, row.url, bookFileName(row));
		if (command === FILE_COMMAND.copyLink && copy.isSome)
			act(() => copy.value(row.url));
	};

	const rowFor = (key: string) => formatRows.find((row) => row.key === key);

	const quickLookOnSpace = (event: KeyboardEvent, path: string | undefined) => {
		const { quickLook } = features;
		if (event.key !== " " || event.repeat || !quickLook.isSome) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.defaultPrevented || path === undefined) return;
		const target = event.target;
		if (
			!(target instanceof HTMLElement) ||
			!spaceMeansQuickLook({
				tagName: target.tagName,
				isContentEditable: target.isContentEditable,
				role: target.getAttribute("role"),
			})
		)
			return;
		event.preventDefault();
		safeAsyncEventHandler(() => quickLook.value(path))();
	};

	return {
		rows: formatRows.map(viewOf),
		onCommand: (key, command) => {
			const row = rowFor(key);
			if (row) run(row, command);
		},
		onCancelDownload: downloads.cancel,
		onContextMenu: (event, key) => {
			const row = rowFor(key);
			if (!row) return;
			contextMenu.openAt(
				event,
				fileMenuEntries(viewOf(row), features, (command) => run(row, command)),
				`${row.label} file actions`,
			);
		},
		onRowKeyDown: (event, key) => {
			const row = rowFor(key);
			quickLookOnSpace(event, row?.kind === "open" ? row.path : undefined);
		},
		onKeyDown: (event) => quickLookOnSpace(event, localPaths[0]),
		contextMenu,
	};
};
