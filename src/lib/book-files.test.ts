import { describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import {
	downloadUrlDragData,
	dragIconPath,
	localPathFromAssetUrl,
	primaryLocalPath,
	primaryRemoteFile,
} from "./book-files";

const book = (overrides: Partial<LibraryBook>): LibraryBook => ({
	id: "b1",
	uuid: null,
	title: "Middlemarch",
	author_list: [],
	tag_list: [],
	sortable_title: null,
	file_list: [],
	cover_image: null,
	identifier_list: [],
	description: null,
	is_read: false,
	series: null,
	series_index: null,
	language_list: [],
	added_at: "2025-01-01T00:00:00Z",
	...overrides,
});

describe("primaryLocalPath", () => {
	it("prefers EPUB over PDF and unknown formats", () => {
		expect(
			primaryLocalPath(
				book({
					file_list: [
						{ Local: { path: "/l/Middlemarch.pdf", mime_type: "PDF" } },
						{ Local: { path: "/l/Middlemarch.zip", mime_type: "ZIP" } },
						{ Local: { path: "/l/Middlemarch.EPUB", mime_type: "EPUB" } },
					],
				}),
			),
		).toBe("/l/Middlemarch.EPUB");
	});

	it("falls back to whatever file there is", () => {
		expect(
			primaryLocalPath(
				book({
					file_list: [{ Local: { path: "C:\\l\\a.lit", mime_type: "LIT" } }],
				}),
			),
		).toBe("C:\\l\\a.lit");
	});

	it("is null without local files", () => {
		expect(primaryLocalPath(book({}))).toBeNull();
		expect(
			primaryLocalPath(
				book({ file_list: [{ Remote: { url: "https://x.example/a.epub" } }] }),
			),
		).toBeNull();
	});
});

describe("primaryRemoteFile", () => {
	it("picks the preferred HTTP file with its name and type", () => {
		expect(
			primaryRemoteFile(
				book({
					file_list: [
						{ Remote: { url: "https://x.example/files/PDF/A%20Book.pdf" } },
						{ Remote: { url: "https://x.example/files/EPUB/A%20Book.epub" } },
					],
				}),
			),
		).toEqual({
			url: "https://x.example/files/EPUB/A%20Book.epub",
			filename: "A Book.epub",
			mimeType: "application/epub+zip",
		});
	});

	it("skips script and data URLs", () => {
		expect(
			primaryRemoteFile(
				book({ file_list: [{ Remote: { url: "javascript:alert(1)" } }] }),
			),
		).toBeNull();
	});
});

describe("downloadUrlDragData", () => {
	it("joins type, name and URL the way Chrome expects", () => {
		expect(
			downloadUrlDragData({
				url: "https://x.example/a.epub",
				filename: "Part 1: Start.epub",
				mimeType: "application/epub+zip",
			}),
		).toBe("application/epub+zip:Part 1_ Start.epub:https://x.example/a.epub");
	});
});

describe("localPathFromAssetUrl", () => {
	it("reads macOS and Linux asset URLs", () => {
		expect(
			localPathFromAssetUrl(
				"asset://localhost/%2FUsers%2Fme%2FLibrary%2Fthumbs%2F1.jpg",
			),
		).toBe("/Users/me/Library/thumbs/1.jpg");
	});

	it("reads Windows asset URLs", () => {
		expect(
			localPathFromAssetUrl("http://asset.localhost/C%3A%5Cthumbs%5C1.jpg"),
		).toBe("C:\\thumbs\\1.jpg");
	});

	it("ignores other URLs", () => {
		expect(localPathFromAssetUrl("https://x.example/cover.jpg")).toBeNull();
		expect(localPathFromAssetUrl("not a url")).toBeNull();
	});
});

describe("dragIconPath", () => {
	it("prefers the thumbnail, then the full cover", () => {
		const withCover = book({
			cover_image: {
				kind: "Local",
				url: "asset://x",
				local_path: "/l/cover.jpg",
			},
		});
		expect(
			dragIconPath(withCover, {
				book_id: "b1",
				url: "asset://localhost/%2Ft%2F1.jpg",
				width: 300,
				height: 450,
			}),
		).toBe("/t/1.jpg");
		expect(dragIconPath(withCover, undefined)).toBe("/l/cover.jpg");
		expect(dragIconPath(book({}), undefined)).toBeNull();
	});
});
