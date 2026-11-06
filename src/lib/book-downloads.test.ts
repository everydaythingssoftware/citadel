import { describe, expect, it } from "vitest";
import { bookFormatRows, remoteBookDownloads } from "./book-downloads";

describe("remote book downloads", () => {
	it("offers HTTP files with a format label and preserves encoded filenames", () => {
		expect(
			remoteBookDownloads([
				{
					Remote: {
						url: "https://books.example/api/books/1/files/EPUB/A%20Book.epub",
					},
				},
				{ Remote: { url: "https://books.example/file" } },
			]),
		).toEqual([
			{
				url: "https://books.example/api/books/1/files/EPUB/A%20Book.epub",
				label: "EPUB",
			},
			{ url: "https://books.example/file", label: "File" },
		]);
	});

	it("omits malformed, script, data, and local file URLs", () => {
		expect(
			remoteBookDownloads([
				{ Remote: { url: "javascript:alert(1)" } },
				{ Remote: { url: "data:text/html,hi" } },
				{ Remote: { url: "file:///books/title.epub" } },
				{ Remote: { url: "not a URL" } },
				{ Remote: { url: "https://books.example/%invalid" } },
			]),
		).toEqual([]);
	});
});

describe("bookFormatRows", () => {
	it("opens local files and downloads remote ones, sorted by format", () => {
		const rows = bookFormatRows([
			{ Remote: { url: "https://example.org/api/books/1/files/PDF/book.pdf" } },
			{
				Local: {
					path: "/lib/Author/Book (1)/Book.epub",
					mime_type: "application/epub+zip",
				},
			},
		]);
		expect(rows.map((row) => [row.kind, row.label])).toEqual([
			["open", "EPUB"],
			["download", "PDF"],
		]);
	});

	it("names a local file without an extension by its MIME type", () => {
		const [row] = bookFormatRows([
			{ Local: { path: "/lib/book", mime_type: "application/pdf" } },
		]);
		expect(row?.label).toBe("application/pdf");
	});
});
