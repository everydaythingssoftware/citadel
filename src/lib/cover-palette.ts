/**
 * Backdrop tints from a cover's colours. The colours themselves are picked
 * once in Rust (citadel-core's cover_colors: OKLab k-means over a downscale,
 * with near-white, near-black and specks set aside) and arrive on the
 * cover's thumbnail descriptor.
 */

import type { CoverPalette, CoverThumbnail, PaletteColor } from "@/bindings";

export type { CoverPalette, PaletteColor };

export interface Oklab {
	l: number;
	a: number;
	b: number;
}

const toLinear = (channel: number): number => {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const srgbToOklab = (r: number, g: number, b: number): Oklab => {
	const lr = toLinear(r);
	const lg = toLinear(g);
	const lb = toLinear(b);
	const l = Math.cbrt(
		0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
	);
	const m = Math.cbrt(
		0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
	);
	const s = Math.cbrt(
		0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
	);
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
};

export const chroma = ({ a, b }: Oklab): number => Math.hypot(a, b);
export const hue = ({ a, b }: Oklab): number =>
	((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;

export interface BackdropColors {
	light: [string, string];
	dark: [string, string];
}

const oklch = (l: number, c: number, h: number): string =>
	`oklch(${(l * 100).toFixed(1)}% ${c.toFixed(3)} ${h.toFixed(1)})`;

/**
 * The palette as calm backdrop tints for each theme: light enough under ink
 * in light mode, deep enough under white text in dark. Hue always comes from
 * the cover; only lightness and chroma are tuned. A one-colour cover gets a
 * deeper shade of the same colour as its second stop.
 */
export const backdropColors = ({
	dominant,
	secondary,
}: CoverPalette): BackdropColors => {
	const tint = (color: Oklab, l: number, maxChroma: number, minChroma = 0) => {
		const c = chroma(color);
		// Greys stay grey: no hue to boost.
		const scaled = c < 0.015 ? c : Math.max(minChroma, Math.min(c, maxChroma));
		return oklch(l, scaled, hue(color));
	};
	const second = secondary ?? dominant;
	const shift = secondary ? 0 : 0.04;
	return {
		light: [tint(dominant, 0.9, 0.07), tint(second, 0.9 - shift, 0.07)],
		dark: [
			tint(dominant, 0.33, 0.09, 0.035),
			tint(second, 0.33 - shift, 0.09, 0.035),
		],
	};
};

/** The drawer's wash for a book: null until its descriptor has a palette. */
export const coverWash = (
	thumb: CoverThumbnail | undefined,
): BackdropColors | null => {
	const palette = thumb?.cover_colors?.palette;
	return palette ? backdropColors(palette) : null;
};
