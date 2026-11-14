import { describe, expect, it } from "vitest";
import { type BookFormatRow, bookFileName } from "./book-downloads";
import {
	FILE_ROW_LAYOUT,
	fileMenuEntries,
	fileRowLayout,
	fileTypeKey,
	formatTone,
	openLabel,
	spaceMeansQuickLook,
} from "./book-file-actions";

const local: BookFormatRow = {
	kind: "open",
	key: "/b/Walden.epub",
	label: "EPUB",
	path: "/Books/Thoreau/Walden (12)/Walden - Henry David Thoreau.epub",
};
const remote: BookFormatRow = {
	kind: "download",
	key: "r",
	label: "PDF",
	url: "https://books.example/api/books/1/files/PDF/The%20Child%20%26%20Tchaikovsky.pdf",
};

describe("bookFileName", () => {
	it("is the last path segment of a local file", () => {
		expect(bookFileName(local)).toBe("Walden - Henry David Thoreau.epub");
		expect(
			bookFileName({ ...local, path: "C:\\Books\\Walden\\Walden.epub" }),
		).toBe("Walden.epub");
	});

	it("is the decoded last URL segment of a remote file", () => {
		expect(bookFileName(remote)).toBe("The Child & Tchaikovsky.pdf");
	});
});

describe("fileRowLayout", () => {
	it("opens local files and downloads remote ones", () => {
		expect(fileRowLayout(local, { compact: true })).toBe(
			FILE_ROW_LAYOUT.desktop,
		);
		expect(fileRowLayout(remote, { compact: false })).toBe(FILE_ROW_LAYOUT.web);
		expect(fileRowLayout(remote, { compact: true })).toBe(
			FILE_ROW_LAYOUT.mobile,
		);
	});
});

describe("openLabel", () => {
	it("names the default app when there is one", () => {
		expect(openLabel({ name: "Kindle", iconDataUrl: "data:" })).toBe(
			"Open in Kindle",
		);
		expect(openLabel(null)).toBe("Open");
		expect(openLabel(undefined)).toBe("Open");
	});
});

describe("fileMenuEntries", () => {
	const base = {
		label: "EPUB",
		defaultApp: { name: "Books", iconDataUrl: "data:" },
		fileManagerName: "Finder",
		canQuickLook: true,
		canReveal: true,
		canCopy: true,
	};
	const labels = (entries: ReturnType<typeof fileMenuEntries>) =>
		entries.map((entry) => (entry.type === "item" ? entry.label : "—"));

	it("offers everything on a Mac", () => {
		expect(
			labels(fileMenuEntries({ ...base, layout: FILE_ROW_LAYOUT.desktop })),
		).toEqual([
			"Open in Books",
			"Quick Look",
			"—",
			"Show in Finder",
			"Copy Path",
		]);
	});

	it("leaves out what the platform can't do", () => {
		expect(
			labels(
				fileMenuEntries({
					...base,
					layout: FILE_ROW_LAYOUT.desktop,
					defaultApp: null,
					fileManagerName: "File Explorer",
					canQuickLook: false,
				}),
			),
		).toEqual(["Open", "—", "Show in File Explorer", "Copy Path"]);
		expect(
			labels(
				fileMenuEntries({
					...base,
					layout: FILE_ROW_LAYOUT.desktop,
					canReveal: false,
					canCopy: false,
				}),
			),
		).toEqual(["Open in Books", "Quick Look"]);
	});

	it("downloads in a browser", () => {
		expect(
			labels(fileMenuEntries({ ...base, layout: FILE_ROW_LAYOUT.web })),
		).toEqual(["Download EPUB", "Copy Link"]);
	});
});

describe("fileTypeKey", () => {
	it("is the lower-cased extension", () => {
		expect(fileTypeKey("/a/b/Walden.EPUB")).toBe("epub");
		expect(fileTypeKey("C:\\x\\y.azw3")).toBe("azw3");
		expect(fileTypeKey("/a/.hidden")).toBe("");
		expect(fileTypeKey("/a/noext")).toBe("");
	});
});

describe("spaceMeansQuickLook", () => {
	const element = (tagName: string, role: string | null = null) => ({
		tagName,
		role,
		isContentEditable: false,
	});

	it("is Quick Look on rows and plain content", () => {
		expect(spaceMeansQuickLook(element("LI"))).toBe(true);
		expect(spaceMeansQuickLook(element("ARTICLE"))).toBe(true);
		expect(spaceMeansQuickLook(element("DIV", "listitem"))).toBe(true);
	});

	it("leaves fields and controls alone", () => {
		expect(spaceMeansQuickLook(element("INPUT"))).toBe(false);
		expect(spaceMeansQuickLook(element("BUTTON"))).toBe(false);
		expect(spaceMeansQuickLook(element("A"))).toBe(false);
		expect(spaceMeansQuickLook(element("DIV", "button"))).toBe(false);
		expect(
			spaceMeansQuickLook({ ...element("DIV"), isContentEditable: true }),
		).toBe(false);
	});
});

describe("formatTone", () => {
	it("groups formats by family", () => {
		expect(formatTone("epub")).toBe("epub");
		expect(formatTone("AZW3")).toBe("kindle");
		expect(formatTone("CBZ")).toBe("comic");
		expect(formatTone("LIT")).toBe("other");
	});
});
