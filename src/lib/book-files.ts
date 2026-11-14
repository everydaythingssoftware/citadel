import type { BookFile, CoverThumbnail, LibraryBook } from "@/bindings";

/**
 * Which file stands for a book when it's read, revealed or dragged out:
 * reflowable ebook formats first, then fixed-layout ones, then anything.
 */
const FORMAT_PREFERENCE = [
	"epub",
	"kepub",
	"azw3",
	"mobi",
	"azw",
	"pdf",
	"cbz",
	"cbr",
	"djvu",
	"fb2",
	"docx",
	"rtf",
	"txt",
] as const;

const extensionOf = (pathOrName: string): string => {
	const name = pathOrName.split(/[\\/]/).at(-1) ?? "";
	return name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
};

const rank = (pathOrName: string): number => {
	const index = (FORMAT_PREFERENCE as readonly string[]).indexOf(
		extensionOf(pathOrName),
	);
	return index === -1 ? FORMAT_PREFERENCE.length : index;
};

const byPreference = <TFile>(files: TFile[], name: (file: TFile) => string) =>
	[...files].sort((a, b) => rank(name(a)) - rank(name(b)));

/** The path of the book's preferred local file (the desktop). */
export const primaryLocalPath = (book: LibraryBook): string | null => {
	const paths = book.file_list.flatMap((file: BookFile) =>
		"Local" in file ? [file.Local.path] : [],
	);
	return byPreference(paths, (path) => path)[0] ?? null;
};

export interface RemoteBookFile {
	url: string;
	filename: string;
	mimeType: string;
}

const MIME_TYPES: Record<string, string> = {
	epub: "application/epub+zip",
	kepub: "application/kepub+zip",
	azw3: "application/vnd.amazon.ebook",
	azw: "application/vnd.amazon.ebook",
	mobi: "application/x-mobipocket-ebook",
	pdf: "application/pdf",
	cbz: "application/vnd.comicbook+zip",
	cbr: "application/vnd.comicbook-rar",
	djvu: "image/vnd.djvu",
	fb2: "application/x-fictionbook+xml",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	rtf: "application/rtf",
	txt: "text/plain",
};

/** The book's preferred file on the server (the web). */
export const primaryRemoteFile = (book: LibraryBook): RemoteBookFile | null => {
	const remote = book.file_list.flatMap((file): RemoteBookFile[] => {
		if (!("Remote" in file)) return [];
		try {
			const url = new URL(file.Remote.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return [];
			const filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			return [
				{
					url: url.href,
					filename: filename || book.title,
					mimeType:
						MIME_TYPES[extensionOf(filename)] ?? "application/octet-stream",
				},
			];
		} catch {
			return [];
		}
	});
	return byPreference(remote, (file) => file.filename)[0] ?? null;
};

/**
 * Chrome's `DownloadURL` drag payload, `mime:filename:url`: dropping it on
 * the desktop or a folder downloads the file. Safari ignores it.
 */
export const downloadUrlDragData = (file: RemoteBookFile): string =>
	`${file.mimeType}:${file.filename.replaceAll(":", "_")}:${file.url}`;

/**
 * The file behind a desktop asset URL (`asset://localhost/<path>` on macOS
 * and Linux, `http(s)://asset.localhost/<path>` on Windows), for handing a
 * cover thumbnail to the native drag as its image.
 */
export const localPathFromAssetUrl = (url: string): string | null => {
	try {
		const parsed = new URL(url);
		const isAsset =
			(parsed.protocol === "asset:" && parsed.hostname === "localhost") ||
			((parsed.protocol === "http:" || parsed.protocol === "https:") &&
				parsed.hostname === "asset.localhost");
		if (!isAsset) return null;
		const path = decodeURIComponent(parsed.pathname.slice(1));
		if (path === "") return null;
		return /^[A-Za-z]:[\\/]/.test(path) ? path : `/${path.replace(/^\/+/, "")}`;
	} catch {
		return null;
	}
};

/** The image a native drag shows: the grid thumbnail, else the cover. */
export const dragIconPath = (
	book: LibraryBook,
	thumb: CoverThumbnail | undefined,
): string | null =>
	(thumb !== undefined ? localPathFromAssetUrl(thumb.url) : null) ??
	book.cover_image?.local_path ??
	null;
