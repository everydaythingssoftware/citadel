import { describe, expect, it } from "vitest";
import type { CoverThumbnail } from "@/bindings";
import {
	backdropColors,
	type CoverPalette,
	chroma,
	coverWash,
	hue,
	srgbToOklab,
} from "./cover-palette";

describe("backdropColors", () => {
	it("keeps the cover's hue and gives a one-colour cover a deeper second stop", () => {
		const colors = backdropColors({
			dominant: { ...srgbToOklab(222, 108, 40), share: 1 },
			secondary: null,
		});
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

describe("coverWash", () => {
	const thumb = (
		cover_colors: CoverThumbnail["cover_colors"],
	): CoverThumbnail => ({
		book_id: "1",
		url: "/api/books/1/thumbnail?v=1",
		width: 300,
		height: 450,
		cover_colors,
	});

	it("coverWash uses the descriptor's palette", () => {
		const palette: CoverPalette = {
			dominant: { ...srgbToOklab(113, 30, 29), share: 0.6 },
			secondary: { ...srgbToOklab(165, 116, 80), share: 0.25 },
		};
		expect(coverWash(thumb({ palette, thumbhash: "" }))).toEqual(
			backdropColors(palette),
		);
		expect(coverWash(undefined)).toBeNull();
		expect(coverWash(thumb(null))).toBeNull();
		expect(coverWash(thumb({ palette: null, thumbhash: "AAAA" }))).toBeNull();
	});
});
