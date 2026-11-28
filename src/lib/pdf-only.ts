import type { BookFile } from "@/bindings";

const lastSegment = (pathOrUrl: string): string =>
	pathOrUrl.split(/[\\/]/).at(-1) ?? "";

const extensionOf = (name: string): string =>
	name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";

/** A format name, extension or MIME type that names a PDF, in any casing. */
export const isPdfFormat = (format: string | null | undefined): boolean => {
	const normalized = format?.trim().toLowerCase();
	return normalized === "pdf" || normalized === "application/pdf";
};

/**
 * The desktop sends Calibre's format name ("PDF") as `mime_type`; the server
 * sends only a URL ending in `<name>.<format>`.
 */
const isPdfFile = (file: BookFile): boolean => {
	if ("Local" in file)
		return (
			isPdfFormat(file.Local.mime_type) ||
			extensionOf(lastSegment(file.Local.path)) === "pdf"
		);
	try {
		const name = decodeURIComponent(
			lastSegment(new URL(file.Remote.url).pathname),
		);
		return extensionOf(name) === "pdf";
	} catch {
		return false;
	}
};

/**
 * A book whose only format is PDF: its cover is its first page, drawn flat
 * like a page rather than bound like a book. A book with no files is not.
 */
export const isPdfOnly = (files: readonly BookFile[]): boolean =>
	files.length > 0 && files.every(isPdfFile);
