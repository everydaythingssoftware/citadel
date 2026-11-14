import type { BookFormatRow } from "@/lib/book-downloads";
import type { FileDownloadState } from "@/lib/file-download";

/** The user's default app for a file, as the desktop reports it. */
export interface DefaultApp {
	name: string;
	iconDataUrl: string;
}

/** Everything one file row shows, worked out by `useBookFiles`. */
export interface BookFileRowView {
	key: string;
	/** "EPUB", "PDF", … */
	format: string;
	fileName: string;
	layout: FileRowLayout;
	/** Desktop: the local path, for Quick Look on Space. */
	path?: string;
	/** Undefined while the desktop is still asking. */
	defaultApp?: DefaultApp | null;
	download: FileDownloadState;
	/** Bytes, where the server told us. */
	size: number | null;
}

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

export const fileRowLayout = (
	row: BookFormatRow,
	{ compact }: { compact: boolean },
): FileRowLayout => {
	if (row.kind === "open") return FILE_ROW_LAYOUT.desktop;
	return compact ? FILE_ROW_LAYOUT.mobile : FILE_ROW_LAYOUT.web;
};

/** "Open in Kindle", or plain "Open" when nothing claims the file type. */
export const openLabel = (app: DefaultApp | null | undefined): string =>
	app ? `Open in ${app.name}` : "Open";

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

export type FileMenuEntry =
	| { type: "item"; command: FileCommand; label: string }
	| { type: "separator"; id: string };

interface FileMenuOptions {
	layout: FileRowLayout;
	label: string;
	defaultApp: DefaultApp | null | undefined;
	fileManagerName: string;
	canQuickLook: boolean;
	canReveal: boolean;
	canCopy: boolean;
}

const item = (command: FileCommand, label: string): FileMenuEntry => ({
	type: "item",
	command,
	label,
});

/**
 * A file row's right-click menu, with only the actions this platform has:
 * Open, Quick Look, Show in Finder, Copy Path on the desktop; Download and
 * Copy Link in a browser.
 */
export const fileMenuEntries = ({
	layout,
	label,
	defaultApp,
	fileManagerName,
	canQuickLook,
	canReveal,
	canCopy,
}: FileMenuOptions): FileMenuEntry[] => {
	if (layout !== FILE_ROW_LAYOUT.desktop) {
		return [
			item(FILE_COMMAND.download, `Download ${label}`),
			...(canCopy ? [item(FILE_COMMAND.copyLink, "Copy Link")] : []),
		];
	}
	const first = [
		item(FILE_COMMAND.open, openLabel(defaultApp)),
		...(canQuickLook ? [item(FILE_COMMAND.quickLook, "Quick Look")] : []),
	];
	const second = [
		...(canReveal
			? [item(FILE_COMMAND.reveal, revealLabel(fileManagerName))]
			: []),
		...(canCopy ? [item(FILE_COMMAND.copyPath, "Copy Path")] : []),
	];
	return second.length > 0
		? [...first, { type: "separator", id: "files" }, ...second]
		: first;
};

/** Lower-cased extension, the key default apps are cached by. */
export const fileTypeKey = (path: string): string => {
	const name = path.split(/[\\/]/).at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const CONTROL_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
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
	!TYPING_TAGS.has(target.tagName) &&
	!CONTROL_TAGS.has(target.tagName) &&
	!target.isContentEditable &&
	!(target.role !== null && CONTROL_ROLES.has(target.role));

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
