import { describe, expect, it, vi } from "vitest";
import type { BookMetadata } from "@/bindings";
import { applyMetadataCover } from "./metadata-import";
import { CoverExpiredError } from "./services/library/types";

const book: BookMetadata = {
	provider: "openlibrary",
	provider_id: "OL1M",
	identifier_label: "openlibrary",
	title: "Dune",
	subtitle: null,
	authors: ["Frank Herbert"],
	isbn: "9780441172719",
	release_year: 1965,
	description: null,
	cover_id: "old",
	publisher: null,
	subjects: [],
	genre_candidates: [],
	language_code: null,
	slug: null,
};

describe("applyMetadataCover", () => {
	it("refreshes an expired cover ID once, silently", async () => {
		const setBookCoverFromMetadata = vi.fn(
			async (_id: string, coverId: string) => {
				if (coverId === "old") throw new CoverExpiredError();
			},
		);
		const refreshCoverId = vi.fn(async () => "fresh");
		await applyMetadataCover("1", book, {
			setBookCoverFromMetadata,
			refreshCoverId,
		});
		expect(setBookCoverFromMetadata.mock.calls.map((call) => call[1])).toEqual([
			"old",
			"fresh",
		]);
		expect(refreshCoverId).toHaveBeenCalledTimes(1);
	});

	it("gives up when the record no longer has a cover, and ignores other errors", async () => {
		const expired = vi.fn(async () => {
			throw new CoverExpiredError();
		});
		await expect(
			applyMetadataCover("1", book, {
				setBookCoverFromMetadata: expired,
				refreshCoverId: async () => null,
			}),
		).rejects.toBeInstanceOf(CoverExpiredError);

		const refreshCoverId = vi.fn(async () => "fresh");
		await expect(
			applyMetadataCover("1", book, {
				setBookCoverFromMetadata: async () => {
					throw new Error("read-only");
				},
				refreshCoverId,
			}),
		).rejects.toThrow("read-only");
		expect(refreshCoverId).not.toHaveBeenCalled();

		const untouched = vi.fn();
		await applyMetadataCover(
			"1",
			{ ...book, cover_id: null },
			{
				setBookCoverFromMetadata: untouched,
				refreshCoverId,
			},
		);
		expect(untouched).not.toHaveBeenCalled();
	});
});
