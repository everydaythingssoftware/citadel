import { describe, expect, it } from "vitest";
import type { BookFile } from "@/bindings";
import { isPdfFormat, isPdfOnly } from "./pdf-only";

// The desktop sends Calibre's format name ("PDF") as `mime_type`; the server
// sends a URL whose path carries the format and the file name.
const local = (path: string, mime_type: string): BookFile => ({
	Local: { path, mime_type },
});
const remote = (format: string, name: string): BookFile => ({
	Remote: { url: `https://lib.example/api/books/1/files/${format}/${name}` },
});

describe("isPdfOnly", () => {
	it("is true when every file is a PDF", () => {
		expect(isPdfOnly([local("C:\\l\\Book.pdf", "PDF")])).toBe(true);
		expect(isPdfOnly([remote("pdf", "Book.pdf")])).toBe(true);
	});

	it("reads the format whatever its casing or spelling", () => {
		expect(isPdfOnly([local("/l/Book.pdf", "pdf")])).toBe(true);
		expect(isPdfOnly([local("/l/Book.pdf", "application/pdf")])).toBe(true);
		expect(isPdfOnly([remote("pdf", "Book.PDF")])).toBe(true);
	});

	it("is false when another format sits beside the PDF", () => {
		expect(
			isPdfOnly([local("/l/Book.epub", "EPUB"), local("/l/Book.pdf", "PDF")]),
		).toBe(false);
		expect(
			isPdfOnly([remote("epub", "Book.epub"), remote("pdf", "Book.pdf")]),
		).toBe(false);
	});

	it("is false for a book without a PDF", () => {
		expect(isPdfOnly([local("/l/Book.epub", "EPUB")])).toBe(false);
		expect(isPdfOnly([remote("epub", "Book.epub")])).toBe(false);
	});

	it("is false for a book with no files", () => {
		expect(isPdfOnly([])).toBe(false);
	});
});

describe("isPdfFormat", () => {
	it("reads a staged upload's format, an extension", () => {
		expect(isPdfFormat("pdf")).toBe(true);
		expect(isPdfFormat("PDF")).toBe(true);
		expect(isPdfFormat("epub")).toBe(false);
		expect(isPdfFormat(undefined)).toBe(false);
	});
});
