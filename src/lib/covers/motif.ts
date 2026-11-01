/**
 * Generated placeholder covers: a muted cloth colour with one simple motif
 * (sun, arch, stripes…), picked and placed by a generator seeded from the
 * book's title so each book always gets the same cover.
 */

export const Motif = {
	sun: "sun",
	arch: "arch",
	stripes: "stripes",
	rings: "rings",
	band: "band",
	dune: "dune",
	peaks: "peaks",
	dots: "dots",
	crescent: "crescent",
} as const;
export type TMotif = (typeof Motif)[keyof typeof Motif];

/** One absolutely positioned layer, in percentages of the cover. */
export interface MotifShape {
	left: number;
	top: number;
	width: number;
	height: number;
	fill: string;
	/** CSS border-radius. */
	radius?: string;
	/** Rotation in degrees. */
	rotate?: number;
	/** CSS clip-path. */
	clip?: string;
	/** A CSS background drawn instead of `fill` (stripes, dots). */
	pattern?: string;
	/** Draws only an outline of `fill`. */
	outline?: boolean;
	opacity?: number;
}

export interface MotifCover {
	motif: TMotif;
	background: string;
	shapes: MotifShape[];
}

/** Brand-safe cloth hues: muted, dark enough for light motifs. */
const HUES = [250, 30, 160, 70, 320, 200, 115, 10];
const CREAM = "oklch(90% 0.03 80)";
const ACCENTS = [
	"oklch(76% 0.13 70)",
	"oklch(70% 0.12 40)",
	CREAM,
	"oklch(82% 0.06 200)",
];

/** FNV-1a: small and well spread for short strings. */
const hash = (seed: string): number => {
	let value = 0x811c9dc5;
	for (let index = 0; index < seed.length; index++) {
		value ^= seed.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return value >>> 0;
};

/** mulberry32: a seeded generator giving numbers in [0, 1). */
export const seededRandom = (seed: string): (() => number) => {
	let state = hash(seed);
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
};

type Draw = (random: () => number, background: string) => MotifShape[];

export const motifCover = (seed: string): MotifCover => {
	const random = seededRandom(seed);
	const between = (low: number, high: number) => low + random() * (high - low);
	const pick = <T>(options: readonly T[]): T =>
		options[Math.floor(random() * options.length)] as T;
	const lightness = Math.round(between(31, 44));
	const chroma = between(0.04, 0.09).toFixed(3);
	const hue = pick(HUES) + Math.round(between(-8, 8));
	const background = `oklch(${lightness}% ${chroma} ${hue})`;
	const accent = () => pick(ACCENTS);

	const draws: Record<TMotif, Draw> = {
		sun: () => {
			const size = between(38, 58);
			const top = between(18, 32);
			return [
				{
					left: 50 - size / 2 + between(-8, 8),
					top,
					width: size,
					height: size / 1.5,
					fill: accent(),
					radius: "50%",
				},
				{
					left: 8,
					top: top + size / 1.5 + 4,
					width: 92,
					height: 1.4,
					fill: CREAM,
				},
			];
		},
		arch: () => [
			{
				left: between(16, 28),
				top: between(18, 32),
				width: between(48, 62),
				height: between(46, 62),
				fill: CREAM,
				radius: "999px 999px 0 0",
			},
		],
		stripes: () => {
			const gap = Math.round(between(10, 16));
			const line = Math.round(between(3, 5));
			return [
				{
					left: 8,
					top: between(14, 32),
					width: 92,
					height: between(34, 52),
					fill: CREAM,
					pattern: `repeating-linear-gradient(to bottom, ${CREAM} 0 ${line}px, transparent ${line}px ${gap}px)`,
				},
			];
		},
		rings: () => {
			const x = between(40, 60);
			const y = between(34, 52);
			const colour = accent();
			return [30, 48, 66].map((size) => ({
				left: x - size / 2,
				top: y - size / 3,
				width: size,
				height: size / 1.5,
				fill: colour,
				radius: "50%",
				outline: true,
			}));
		},
		band: () => [
			{
				left: -30,
				top: between(34, 52),
				width: 160,
				height: between(12, 20),
				fill: accent(),
				rotate: Math.round(between(-35, -15)),
			},
		],
		dune: () => {
			const size = between(120, 170);
			return [
				{
					left: 50 - size / 2,
					top: between(52, 68),
					width: size,
					height: size / 1.5,
					fill: CREAM,
					radius: "50%",
				},
			];
		},
		peaks: () => {
			const top = between(28, 46);
			return [
				{
					left: 8,
					top,
					width: 92,
					height: 100 - top,
					fill: CREAM,
					clip: `polygon(${Math.round(between(35, 65))}% 0, 100% 100%, 0 100%)`,
				},
				{
					left: 8,
					top: top + between(12, 22),
					width: 92,
					height: 100 - top,
					fill: accent(),
					opacity: 0.85,
					clip: `polygon(${Math.round(between(60, 90))}% 0, 100% 100%, 10% 100%)`,
				},
			];
		},
		dots: () => [
			{
				left: between(16, 26),
				top: between(16, 30),
				width: between(56, 68),
				height: between(36, 56),
				fill: CREAM,
				pattern: `radial-gradient(${CREAM} 2px, transparent 2.5px) 0 0 / 12px 12px`,
			},
		],
		crescent: (_, behind) => {
			const size = between(44, 60);
			const left = between(20, 32);
			const top = between(18, 30);
			return [
				{
					left,
					top,
					width: size,
					height: size / 1.5,
					fill: accent(),
					radius: "50%",
				},
				{
					left: left + size * 0.3,
					top: top - size * 0.07,
					width: size,
					height: size / 1.5,
					fill: behind,
					radius: "50%",
				},
			];
		},
	};

	const motif = pick(Object.values(Motif));
	return { motif, background, shapes: draws[motif](random, background) };
};
