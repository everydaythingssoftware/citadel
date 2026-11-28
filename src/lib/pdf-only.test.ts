import { expect, it } from "vitest";
import type { BookFile } from "@/bindings";
import { isPdfOnly } from "./pdf-only";

// The desktop sends Calibre's format name as `mime_type`; the server sends
// only a URL ending in the file's name.
const local = (path: string, mime_type: string): BookFile => ({
	Local: { path, mime_type },
});
const remote = (name: string): BookFile => ({
	Remote: { url: `https://lib.example/api/books/1/files/${name}` },
});

it("is true only when every file is a PDF", () => {
	expect(isPdfOnly([local("C:\\l\\Book.pdf", "PDF")])).toBe(true);
	expect(isPdfOnly([remote("Book.PDF")])).toBe(true);
	expect(
		isPdfOnly([local("/l/Book.epub", "EPUB"), local("/l/Book.pdf", "PDF")]),
	).toBe(false);
	expect(isPdfOnly([remote("Book.epub")])).toBe(false);
	expect(isPdfOnly([])).toBe(false);
});
