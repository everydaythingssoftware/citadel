import { describe, expect, it } from "vitest";
import { fitMiddleTruncated, middleTruncate } from "./middle-truncate";

describe("middleTruncate", () => {
	it("leaves text that fits alone", () => {
		expect(middleTruncate("Walden.epub", 20)).toBe("Walden.epub");
		expect(middleTruncate("Walden.epub", 11)).toBe("Walden.epub");
	});

	it("cuts from the middle, keeping the start and the extension", () => {
		expect(middleTruncate("The Child & Tchaikovsky.epub", 27)).toBe(
			"The Child & T…aikovsky.epub",
		);
	});

	it("never exceeds the length it was given", () => {
		const name = "A Very Long Title That Goes On and On - Someone.pdf";
		for (let length = 1; length < name.length; length++) {
			expect(
				Array.from(middleTruncate(name, length)).length,
			).toBeLessThanOrEqual(length);
		}
	});

	it("keeps the whole extension once the start gets short", () => {
		expect(middleTruncate("Anathem - Neal Stephenson.kepub", 9)).toBe(
			"An….kepub",
		);
	});

	it("doesn't leave spaces against the ellipsis", () => {
		expect(middleTruncate("Moby Dick or The Whale.epub", 12)).toBe(
			"Moby…e.epub",
		);
	});

	it("counts characters, not UTF-16 units", () => {
		expect(middleTruncate("📚📚📚📚📚📚📚📚.epub", 10)).toBe("📚📚📚📚….epub");
	});

	it("treats a name without an extension evenly", () => {
		expect(middleTruncate("abcdefghijklmnop", 7)).toBe("abc…nop");
	});
});

describe("fitMiddleTruncated", () => {
	const fitsIn = (width: number) => (candidate: string) =>
		Array.from(candidate).length <= width;

	it("returns the text when it fits", () => {
		expect(fitMiddleTruncated("Walden.epub", fitsIn(40))).toBe("Walden.epub");
	});

	it("finds the longest truncation that fits", () => {
		expect(fitMiddleTruncated("The Child & Tchaikovsky.epub", fitsIn(27))).toBe(
			"The Child & T…aikovsky.epub",
		);
	});

	it("falls back to the shortest form when nothing fits", () => {
		expect(fitMiddleTruncated("Walden.epub", () => false)).toBe("…");
	});
});
