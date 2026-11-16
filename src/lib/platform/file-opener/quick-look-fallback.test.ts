import { describe, expect, it, vi } from "vitest";
import { quickLookWithFallback } from "./quick-look-fallback";

const setup = (
	quickLook: (path: string) => Promise<void>,
	openPath: (path: string) => Promise<void> = async () => {},
) => {
	const preview = vi.fn(quickLook);
	const open = vi.fn(openPath);
	return {
		preview,
		open,
		fallback: quickLookWithFallback({ quickLook: preview, openPath: open }),
	};
};

describe("quickLookWithFallback", () => {
	it("previews while Quick Look works", async () => {
		const { preview, open, fallback } = setup(async () => {});
		await fallback.quickLook("/a/book.epub");
		expect(preview).toHaveBeenCalledWith("/a/book.epub");
		expect(open).not.toHaveBeenCalled();
		expect(fallback.available()).toBe(true);
	});

	it("opens the default app once Quick Look fails, and stops offering it", async () => {
		const { preview, open, fallback } = setup(async () => {
			throw new Error("Quick Look is unavailable.");
		});
		await fallback.quickLook("/a/book.epub");
		expect(open).toHaveBeenCalledWith("/a/book.epub");
		expect(fallback.available()).toBe(false);

		await fallback.quickLook("/a/other.epub");
		expect(preview).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenLastCalledWith("/a/other.epub");
	});

	it("keeps Quick Look when the file itself can't be opened", async () => {
		const { fallback } = setup(
			async () => {
				throw new Error("/a/gone.epub does not exist.");
			},
			async () => {
				throw new Error("no such file");
			},
		);
		await expect(fallback.quickLook("/a/gone.epub")).rejects.toThrow(
			"does not exist",
		);
		expect(fallback.available()).toBe(true);
	});
});
