import type { BookFile } from "@/bindings";

export interface BookDownload {
	url: string;
	label: string;
}

export const remoteBookDownloads = (files: BookFile[]): BookDownload[] =>
	files.flatMap((file) => {
		if (!("Remote" in file)) return [];
		try {
			const url = new URL(file.Remote.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return [];
			const filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			const extension = filename.split(".").at(-1);
			return [
				{
					url: url.href,
					label:
						extension && extension !== filename
							? extension.toUpperCase()
							: "File",
				},
			];
		} catch {
			return [];
		}
	});

/** One row of a book's Formats panel: a file to open here or download. */
export type BookFormatRow =
	| { kind: "open"; key: string; label: string; path: string }
	| { kind: "download"; key: string; label: string; url: string };

const extensionLabel = (path: string, fallback: string) => {
	const name = path.split(/[\\/]/).at(-1) ?? "";
	const extension = name.includes(".") ? name.split(".").at(-1) : undefined;
	return extension ? extension.toUpperCase() : fallback;
};

/**
 * Local files (desktop) open in their default app; remote files (web)
 * download. Sorted by label so the list reads the same every visit.
 */
export const bookFormatRows = (files: BookFile[]): BookFormatRow[] =>
	[
		...files.flatMap((file): BookFormatRow[] =>
			"Local" in file
				? [
						{
							kind: "open",
							key: file.Local.path,
							label: extensionLabel(file.Local.path, file.Local.mime_type),
							path: file.Local.path,
						},
					]
				: [],
		),
		...remoteBookDownloads(files).map(
			(file): BookFormatRow => ({
				kind: "download",
				key: file.url,
				label: file.label,
				url: file.url,
			}),
		),
	].sort((a, b) => a.label.localeCompare(b.label));

/** The file's own name, as Finder or the download would show it. */
export const bookFileName = (row: BookFormatRow): string => {
	if (row.kind === "open") return row.path.split(/[\\/]/).at(-1) ?? row.path;
	try {
		const segment = new URL(row.url).pathname.split("/").at(-1) ?? "";
		return decodeURIComponent(segment) || row.label;
	} catch {
		return row.label;
	}
};
