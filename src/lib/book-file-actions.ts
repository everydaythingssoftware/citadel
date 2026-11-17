import type { BookFormatRow } from "@/lib/book-downloads";
import { type ContextMenuEntry, tidyEntries } from "@/lib/context-menu";
import {
	downloadFraction,
	downloadProgressText,
	type FileDownloadState,
	formatByteSize,
} from "@/lib/file-download";
import { isEditableTarget } from "@/lib/keymap";
import { none, type Option, some } from "@/lib/option";
import type { DefaultApp } from "@/lib/platform/types";

/**
 * How a file row behaves: the desktop opens and reveals local files; a
 * browser downloads them, with an icon button on a desktop-sized screen and
 * the whole row as the button on a phone.
 */
export const FILE_ROW_LAYOUT = {
	desktop: "desktop",
	web: "web",
	mobile: "mobile",
} as const;
export type FileRowLayout =
	(typeof FILE_ROW_LAYOUT)[keyof typeof FILE_ROW_LAYOUT];

interface FileRowBase {
	key: string;
	/** "EPUB", "PDF", … */
	format: string;
	fileName: string;
}

/** Everything one file row shows, worked out by `useBookFiles`. */
export type BookFileRowView =
	| (FileRowBase & {
			layout: typeof FILE_ROW_LAYOUT.desktop;
			/** None while the desktop is still asking. */
			defaultApp: Option<Option<DefaultApp>>;
			/** "Show in Finder", where the platform can. */
			reveal: Option<string>;
	  })
	| (FileRowBase & {
			layout: typeof FILE_ROW_LAYOUT.web;
			download: FileDownloadState;
	  })
	| (FileRowBase & {
			layout: typeof FILE_ROW_LAYOUT.mobile;
			download: FileDownloadState;
			/** Bytes, where the server told us. */
			size: Option<number>;
	  });

export const fileRowLayout = (
	row: BookFormatRow,
	{ compact }: { compact: boolean },
): FileRowLayout => {
	if (row.kind === "open") return FILE_ROW_LAYOUT.desktop;
	return compact ? FILE_ROW_LAYOUT.mobile : FILE_ROW_LAYOUT.web;
};

/** "Open in Kindle", or plain "Open" until an app is known to claim it. */
export const openLabel = (app: Option<Option<DefaultApp>>): string =>
	app.isSome && app.value.isSome ? `Open in ${app.value.value.name}` : "Open";

export const revealLabel = (fileManagerName: string): string =>
	`Show in ${fileManagerName}`;

export const FILE_COMMAND = {
	open: "open",
	quickLook: "quick-look",
	reveal: "reveal",
	copyPath: "copy-path",
	download: "download",
	copyLink: "copy-link",
} as const;
export type FileCommand = (typeof FILE_COMMAND)[keyof typeof FILE_COMMAND];

/** What the platform can do beyond what a row already says. */
export interface FileMenuFeatures {
	quickLook: Option<(path: string) => Promise<void>>;
	copy: Option<(text: string) => Promise<void>>;
}

/**
 * A file row's right-click menu, with only the actions this platform has:
 * Open, Quick Look, Show in Finder, Copy Path on the desktop; Download and
 * Copy Link in a browser.
 */
export const fileMenuEntries = (
	row: BookFileRowView,
	{ quickLook, copy }: FileMenuFeatures,
	run: (command: FileCommand) => void,
): ContextMenuEntry[] => {
	const entry = (command: FileCommand, label: string): ContextMenuEntry[] => [
		{ id: command, label, onSelect: () => run(command) },
	];
	if (row.layout !== FILE_ROW_LAYOUT.desktop)
		return [
			...entry(FILE_COMMAND.download, `Download ${row.format}`),
			...(copy.isSome ? entry(FILE_COMMAND.copyLink, "Copy Link") : []),
		];
	return tidyEntries([
		...entry(FILE_COMMAND.open, openLabel(row.defaultApp)),
		...(quickLook.isSome ? entry(FILE_COMMAND.quickLook, "Quick Look") : []),
		{ type: "separator", id: "files" },
		...(row.reveal.isSome ? entry(FILE_COMMAND.reveal, row.reveal.value) : []),
		...(copy.isSome ? entry(FILE_COMMAND.copyPath, "Copy Path") : []),
	]);
};

const CONTROL_TAGS = new Set(["INPUT", "BUTTON", "A", "SUMMARY"]);
const CONTROL_ROLES = new Set([
	"button",
	"link",
	"menuitem",
	"checkbox",
	"switch",
	"tab",
]);

/**
 * Whether Space on this element may mean Quick Look rather than typing a
 * space or pressing a control, the way Finder treats Space.
 */
export const spaceMeansQuickLook = (target: {
	tagName: string;
	isContentEditable: boolean;
	role: string | null;
}): boolean =>
	!isEditableTarget(target) &&
	!CONTROL_TAGS.has(target.tagName) &&
	!(target.role !== null && CONTROL_ROLES.has(target.role));

const percentOf = (download: FileDownloadState): string => {
	const fraction = downloadFraction(download);
	return fraction === null ? "" : `, ${Math.round(fraction * 100)}%`;
};

/** The download button's name: what pressing it does now. */
export const downloadButtonLabel = (
	format: string,
	download: FileDownloadState,
): string => {
	switch (download.status) {
		case "downloading":
			return `Stop downloading ${format}`;
		case "failed":
			return `Try downloading ${format} again`;
		case "done":
			return `Download ${format} again`;
		case "idle":
			return `Download ${format}`;
	}
};

/** The same, with how far a running download has got. */
export const downloadButtonAccessibleLabel = (
	format: string,
	download: FileDownloadState,
): string => `${downloadButtonLabel(format, download)}${percentOf(download)}`;

/** A phone row is the button: its name says what it does and to what. */
export const mobileRowLabel = (
	row: Extract<BookFileRowView, { layout: "mobile" }>,
): string =>
	row.download.status === "downloading"
		? downloadButtonAccessibleLabel(row.format, row.download)
		: `Download ${row.format}, ${row.fileName}${row.size.isSome ? `, ${formatByteSize(row.size.value)}` : ""}`;

/** "Downloading… 3.9 of 8.4 MB" or "… Tap to try again."; none otherwise. */
export const mobileRowDetail = (
	download: FileDownloadState,
): Option<string> => {
	switch (download.status) {
		case "downloading":
			return some(
				`Downloading… ${downloadProgressText(download.received, download.total)}`,
			);
		case "failed":
			return some(`${download.message}. Tap to try again.`);
		default:
			return none();
	}
};

/** Colour family for a format's badge; Kindle formats share one. */
export const FORMAT_TONE = {
	epub: "epub",
	pdf: "pdf",
	kindle: "kindle",
	comic: "comic",
	text: "text",
	other: "other",
} as const;
export type FormatTone = (typeof FORMAT_TONE)[keyof typeof FORMAT_TONE];

const TONES: Record<string, FormatTone> = {
	EPUB: FORMAT_TONE.epub,
	KEPUB: FORMAT_TONE.epub,
	PDF: FORMAT_TONE.pdf,
	MOBI: FORMAT_TONE.kindle,
	AZW: FORMAT_TONE.kindle,
	AZW3: FORMAT_TONE.kindle,
	AZW4: FORMAT_TONE.kindle,
	KFX: FORMAT_TONE.kindle,
	CBZ: FORMAT_TONE.comic,
	CBR: FORMAT_TONE.comic,
	CB7: FORMAT_TONE.comic,
	TXT: FORMAT_TONE.text,
	RTF: FORMAT_TONE.text,
	DOCX: FORMAT_TONE.text,
	HTML: FORMAT_TONE.text,
	HTMLZ: FORMAT_TONE.text,
	MD: FORMAT_TONE.text,
	FB2: FORMAT_TONE.text,
};

export const formatTone = (label: string): FormatTone =>
	TONES[label.toUpperCase()] ?? FORMAT_TONE.other;
