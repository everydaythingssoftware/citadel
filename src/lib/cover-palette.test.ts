import { describe, expect, it } from "vitest";
import {
	backdropColors,
	chroma,
	extractCoverPalette,
	hue,
	srgbToOklab,
} from "./cover-palette";

const must = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error("missing value");
	return value;
};

/** RGBA pixels: each [r, g, b, count] repeated `count` times. */
const pixels = (...runs: [number, number, number, number][]): number[] =>
	runs.flatMap(([r, g, b, count]) =>
		Array.from({ length: count }, () => [r, g, b, 255]).flat(),
	);

describe("extractCoverPalette", () => {
	it("takes the biggest colour first and a distinct second", () => {
		const palette = extractCoverPalette(
			pixels([113, 30, 29, 60], [165, 116, 80, 25], [250, 250, 250, 15]),
		);
		const { dominant, secondary } = must(palette);
		const red = srgbToOklab(113, 30, 29);
		const amber = srgbToOklab(165, 116, 80);
		expect(hue(dominant)).toBeCloseTo(hue(red), 0);
		expect(hue(must(secondary))).toBeCloseTo(hue(amber), 0);
	});

	it("ignores specks, near-white and near-black", () => {
		const palette = extractCoverPalette(
			pixels(
				[234, 222, 176, 80],
				[20, 140, 60, 1],
				[5, 5, 5, 10],
				[255, 255, 255, 9],
			),
		);
		expect(must(palette).secondary).toBeNull();
		expect(hue(must(palette).dominant)).toBeCloseTo(
			hue(srgbToOklab(234, 222, 176)),
			0,
		);
	});

	it("is null for a cover of only paper and ink", () => {
		expect(
			extractCoverPalette(pixels([255, 255, 255, 50], [0, 0, 0, 50])),
		).toBeNull();
	});

	it("skips transparent pixels", () => {
		expect(extractCoverPalette([200, 40, 40, 0])).toBeNull();
	});
});

describe("backdropColors", () => {
	it("keeps the cover's hue and gives a one-colour cover a deeper second stop", () => {
		const palette = extractCoverPalette(pixels([222, 108, 40, 100]));
		const colors = backdropColors(must(palette));
		const orangeHue = hue(srgbToOklab(222, 108, 40)).toFixed(1);
		expect(colors.light[0]).toContain(orangeHue);
		expect(colors.light[1]).toContain(orangeHue);
		expect(colors.light[0]).not.toBe(colors.light[1]);
		expect(colors.dark[0]).toMatch(/^oklch\(33\.0%/);
	});

	it("leaves a grey cover grey", () => {
		const grey = srgbToOklab(120, 120, 120);
		expect(chroma(grey)).toBeLessThan(0.015);
		const colors = backdropColors({
			dominant: { ...grey, share: 1 },
			secondary: null,
		});
		expect(colors.dark[0]).toMatch(/ 0\.00\d /);
	});
});
