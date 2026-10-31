import { describe, expect, it } from "vitest";
import { Motif, motifCover, seededRandom } from "./motif";

describe("generated motif covers", () => {
	it("gives a title the same cover every time", () => {
		expect(motifCover("Walden")).toEqual(motifCover("Walden"));
		expect(motifCover("Walden")).not.toEqual(motifCover("Kim"));
	});

	it("draws every motif somewhere across a library", () => {
		const motifs = new Set(
			Array.from(
				{ length: 300 },
				(_, index) => motifCover(`Book ${index}`).motif,
			),
		);
		expect([...motifs].sort()).toEqual(Object.values(Motif).sort());
	});

	it("keeps cloth colours muted and dark", () => {
		for (let index = 0; index < 100; index++) {
			const match = motifCover(`Book ${index}`).background.match(
				/^oklch\((\d+)% (0\.\d+) (-?\d+)\)$/,
			);
			expect(match).not.toBeNull();
			expect(Number(match?.[1])).toBeGreaterThanOrEqual(31);
			expect(Number(match?.[1])).toBeLessThanOrEqual(44);
			expect(Number(match?.[2])).toBeLessThanOrEqual(0.09);
		}
	});

	it("generates numbers in [0, 1) from a seed", () => {
		const random = seededRandom("seed");
		const values = Array.from({ length: 1000 }, random);
		expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...values)).toBeLessThan(1);
		expect(seededRandom("seed")()).toBe(values[0]);
	});
});
