import { describe, expect, it, vi } from "vitest";
import { none, some } from "@/lib/option";
import { type BookFormatRow, bookFileName } from "./book-downloads";
import {
	type BookFileRowView,
	downloadButtonAccessibleLabel,
	downloadButtonLabel,
	FILE_COMMAND,
	FILE_ROW_LAYOUT,
	fileMenuEntries,
	fileRowLayout,
	formatTone,
	mobileRowDetail,
	openLabel,
	spaceMeansQuickLook,
} from "./book-file-actions";

const books = { name: "Books", iconDataUrl: "data:" };

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
	it("names the default app once one is known", () => {
		expect(openLabel(some(some(books)))).toBe("Open in Books");
		expect(openLabel(some(none()))).toBe("Open");
		expect(openLabel(none())).toBe("Open");
	});
});

describe("fileMenuEntries", () => {
	const desktop: BookFileRowView = {
		key: "k",
		format: "EPUB",
		fileName: "Walden.epub",
		layout: FILE_ROW_LAYOUT.desktop,
		defaultApp: some(some(books)),
		reveal: some("Show in Finder"),
	};
	const web: BookFileRowView = {
		key: "k",
		format: "EPUB",
		fileName: "Walden.epub",
		layout: FILE_ROW_LAYOUT.web,
		download: { status: "idle" },
	};
	const task = async () => {};
	const everything = { quickLook: some(task), copy: some(task) };
	const labels = (entries: ReturnType<typeof fileMenuEntries>) =>
		entries.map((entry) => (entry.type === "separator" ? "—" : entry.label));

	it("offers everything on a Mac", () => {
		expect(labels(fileMenuEntries(desktop, everything, () => {}))).toEqual([
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
				fileMenuEntries(
					{
						...desktop,
						defaultApp: some(none()),
						reveal: some("Show in File Explorer"),
					},
					{ ...everything, quickLook: none() },
					() => {},
				),
			),
		).toEqual(["Open", "—", "Show in File Explorer", "Copy Path"]);
		expect(
			labels(
				fileMenuEntries(
					{ ...desktop, reveal: none() },
					{ ...everything, copy: none() },
					() => {},
				),
			),
		).toEqual(["Open in Books", "Quick Look"]);
	});

	it("downloads in a browser", () => {
		expect(labels(fileMenuEntries(web, everything, () => {}))).toEqual([
			"Download EPUB",
			"Copy Link",
		]);
	});

	it("runs the chosen command", () => {
		const run = vi.fn();
		const [first] = fileMenuEntries(web, everything, run);
		if (first?.type !== "separator") first?.onSelect();
		expect(run).toHaveBeenCalledWith(FILE_COMMAND.download);
	});
});

describe("download labels", () => {
	it("say what pressing the button does now", () => {
		expect(downloadButtonLabel("PDF", { status: "idle" })).toBe("Download PDF");
		expect(downloadButtonLabel("PDF", { status: "done" })).toBe(
			"Download PDF again",
		);
		expect(
			downloadButtonAccessibleLabel("PDF", {
				status: "downloading",
				received: 1,
				total: 4,
			}),
		).toBe("Stop downloading PDF, 25%");
	});

	it("give a phone row its detail line only while it has news", () => {
		expect(mobileRowDetail({ status: "idle" })).toEqual(none());
		expect(
			mobileRowDetail({ status: "failed", message: "Couldn't download" }),
		).toEqual(some("Couldn't download. Tap to try again."));
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
