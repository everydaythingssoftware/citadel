import { describe, expect, it, vi } from "vitest";
import { cacheByExtension, fileExtension } from "./default-app-cache";

const kindle = { name: "Kindle", iconDataUrl: "data:image/png;base64,AA==" };

describe("fileExtension", () => {
	it("reads the lowercased extension of the file name", () => {
		expect(fileExtension("/books/A Title.EPUB")).toBe("epub");
		expect(fileExtension("C:\\Books\\b.v2\\book.mobi")).toBe("mobi");
	});

	it("finds none in dotfiles, bare names or folder dots", () => {
		expect(fileExtension("/books/.hidden")).toBeNull();
		expect(fileExtension("/books/README")).toBeNull();
		expect(fileExtension("/books.d/README")).toBeNull();
		expect(fileExtension("/books/trailing.")).toBeNull();
	});
});

describe("cacheByExtension", () => {
	it("looks each extension up once", async () => {
		const lookup = vi.fn(async () => kindle);
		const defaultApp = cacheByExtension(lookup);
		await defaultApp("/a/one.epub");
		await expect(defaultApp("/b/two.EPUB")).resolves.toEqual(kindle);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("looks files without an extension up every time", async () => {
		const lookup = vi.fn(async () => null);
		const defaultApp = cacheByExtension(lookup);
		await defaultApp("/a/one");
		await defaultApp("/a/one");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("reads a failure as no app and tries again", async () => {
		const lookup = vi
			.fn<(path: string) => Promise<typeof kindle | null>>()
			.mockRejectedValueOnce(new Error("busy"))
			.mockResolvedValue(kindle);
		const defaultApp = cacheByExtension(lookup);
		await expect(defaultApp("/a/one.epub")).resolves.toBeNull();
		await expect(defaultApp("/a/one.epub")).resolves.toEqual(kindle);
	});
});
