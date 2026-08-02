import { describe, expect, it } from "vitest";
import type { BookMetadata, MetadataProvider } from "@/bindings";
import { mergeResults } from "./aggregate";

const book = (
	provider: MetadataProvider,
	overrides: Partial<BookMetadata> = {},
): BookMetadata => ({
	provider,
	provider_id: `${provider}-id`,
	identifier_label: provider,
	title: "A Title",
	subtitle: null,
	authors: ["An Author"],
	isbn: null,
	release_year: null,
	description: null,
	image_url: null,
	publisher: null,
	subjects: [],
	genre_candidates: [],
	language_code: null,
	slug: null,
	...overrides,
});

const ORDER: MetadataProvider[] = ["loc", "dnb", "openlibrary", "hardcover"];

describe("mergeResults", () => {
	it("collapses same-ISBN records to the highest-preference whole record", () => {
		const results = mergeResults(
			[
				book("openlibrary", { isbn: "9780553103540", title: "OL Title" }),
				book("loc", { isbn: "9780553103540", title: "LoC Title" }),
			],
			ORDER,
			null,
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.book.title).toBe("LoC Title");
		expect(results[0]?.book.provider).toBe("loc");
		expect(results[0]?.alsoOn).toEqual(["Open Library"]);
	});

	it("matches ISBN-10 and ISBN-13 forms as the same edition", () => {
		const results = mergeResults(
			[
				book("openlibrary", { isbn: "9780553103540" }),
				book("loc", { isbn: "9780553103540" }),
			],
			ORDER,
			null,
		);
		expect(results).toHaveLength(1);
	});

	it("backfills a missing cover from a deduped peer", () => {
		const results = mergeResults(
			[
				book("loc", { isbn: "9780553103540", image_url: null }),
				book("openlibrary", {
					isbn: "9780553103540",
					image_url: "https://covers/x.jpg",
				}),
			],
			ORDER,
			null,
		);
		expect(results[0]?.book.provider).toBe("loc");
		expect(results[0]?.book.image_url).toBe("https://covers/x.jpg");
	});

	it("does not splice non-cover fields across providers", () => {
		const results = mergeResults(
			[
				book("loc", { isbn: "9780553103540", subjects: ["Fantasy"] }),
				book("openlibrary", {
					isbn: "9780553103540",
					subjects: ["Different"],
					publisher: "OL Publisher",
				}),
			],
			ORDER,
			null,
		);
		expect(results[0]?.book.subjects).toEqual(["Fantasy"]);
		expect(results[0]?.book.publisher).toBeNull();
	});

	it("combines only provenanced genre candidates across matching records", () => {
		const results = mergeResults(
			[
				book("loc", {
					isbn: "9780553103540",
					genre_candidates: [
						{ name: "Fantasy", source: "marc:655", vocabulary: "lcgft" },
					],
				}),
				book("hardcover", {
					isbn: "9780553103540",
					genre_candidates: [
						{
							name: "fantasy",
							source: "hardcover:genre",
							vocabulary: "hardcover",
						},
						{
							name: "Epic Fantasy",
							source: "hardcover:genre",
							vocabulary: "hardcover",
						},
					],
				}),
			],
			ORDER,
			null,
		);
		expect(results[0]?.book.genre_candidates).toEqual([
			{ name: "Fantasy", source: "marc:655", vocabulary: "lcgft" },
			{
				name: "Epic Fantasy",
				source: "hardcover:genre",
				vocabulary: "hardcover",
			},
		]);
	});

	it("keeps ISBN-less records as distinct rows", () => {
		const results = mergeResults(
			[book("loc", { isbn: null }), book("dnb", { isbn: null })],
			ORDER,
			null,
		);
		expect(results).toHaveLength(2);
	});

	it("pins the row matching the file's ISBN to the top", () => {
		const results = mergeResults(
			[
				book("hardcover", { isbn: "9780000000001", title: "First" }),
				book("loc", { isbn: "9780553103540", title: "The Match" }),
			],
			ORDER,
			"0553103547", // ISBN-10 of the LoC row's ISBN-13
		);
		expect(results[0]?.book.title).toBe("The Match");
		expect(results[0]?.isIsbnMatch).toBe(true);
		expect(results[1]?.isIsbnMatch).toBe(false);
	});
});
