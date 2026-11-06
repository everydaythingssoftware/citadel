/**
 * Colours for a book's backdrop, taken from its cover: the cover's pixels
 * are grouped in OKLab (k-means), near-white, near-black and specks are set
 * aside, and the biggest groups that remain are the cover's colours. Nothing
 * is invented: a cover of one colour gets one colour.
 */

export interface Oklab {
	l: number;
	a: number;
	b: number;
}

export interface PaletteColor extends Oklab {
	/** Share of the cover's counted pixels in this colour, 0–1. */
	share: number;
}

export interface CoverPalette {
	dominant: PaletteColor;
	secondary: PaletteColor | null;
}

const CLUSTERS = 6;
const ITERATIONS = 10;
/** Groups smaller than this are specks: thin lines, small type. */
const MIN_SHARE = 0.02;
/** Two colours closer than this read as the same colour. */
const DISTINCT = 0.08;

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

const distance = (x: Oklab, y: Oklab): number =>
	Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);

/** Too close to paper or ink to say anything about the cover. */
const isNeutralExtreme = (color: Oklab): boolean =>
	color.l < 0.16 || (color.l > 0.96 && chroma(color) < 0.03);

/** Spread starting centres across the colours present (farthest-first). */
const seed = (points: Oklab[]): Oklab[] => {
	const first = points[0];
	if (!first) return [];
	const centres = [first];
	while (centres.length < Math.min(CLUSTERS, points.length)) {
		let best: Oklab | undefined;
		let bestDistance = -1;
		for (const point of points) {
			const nearest = Math.min(...centres.map((c) => distance(point, c)));
			if (nearest > bestDistance) {
				bestDistance = nearest;
				best = point;
			}
		}
		if (!best || bestDistance === 0) break;
		centres.push(best);
	}
	return centres;
};

const cluster = (points: Oklab[]): PaletteColor[] => {
	let centres = seed(points);
	let assignment = new Array<number>(points.length).fill(0);
	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		assignment = points.map((point) => {
			let index = 0;
			let nearest = Number.POSITIVE_INFINITY;
			centres.forEach((centre, i) => {
				const d = distance(point, centre);
				if (d < nearest) {
					nearest = d;
					index = i;
				}
			});
			return index;
		});
		centres = centres.map((centre, i) => {
			const members = points.filter((_, p) => assignment[p] === i);
			if (members.length === 0) return centre;
			return {
				l: members.reduce((sum, m) => sum + m.l, 0) / members.length,
				a: members.reduce((sum, m) => sum + m.a, 0) / members.length,
				b: members.reduce((sum, m) => sum + m.b, 0) / members.length,
			};
		});
	}
	return centres.map((centre, i) => ({
		...centre,
		share: assignment.filter((a) => a === i).length / points.length,
	}));
};

/**
 * The cover's colours from its RGBA pixels (a small downscale is plenty).
 * Null when the cover is all paper and ink, or transparent.
 */
export const extractCoverPalette = (
	rgba: ArrayLike<number>,
): CoverPalette | null => {
	const points: Oklab[] = [];
	for (let i = 0; i + 3 < rgba.length; i += 4) {
		if ((rgba[i + 3] ?? 0) < 128) continue;
		points.push(srgbToOklab(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0));
	}
	if (points.length === 0) return null;
	const colors = cluster(points)
		.filter((color) => color.share >= MIN_SHARE && !isNeutralExtreme(color))
		.sort((x, y) => y.share - x.share);
	const [dominant, ...rest] = colors;
	if (!dominant) return null;
	const secondary =
		rest.find((color) => distance(color, dominant) >= DISTINCT) ?? null;
	return { dominant, secondary };
};

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
