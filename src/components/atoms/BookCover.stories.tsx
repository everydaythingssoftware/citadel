import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef, useState } from "react";
import type { CoverColors } from "@/bindings";
import artwork1 from "../../assets/1.jpg";
import artwork from "../../assets/2.jpg";
import { BookCover, type BookCoverProps } from "./BookCover";
import showcase from "./BookCover.stories.module.css";

const meta: Meta<typeof BookCover> = {
	title: "Atoms/BookCover",
	component: BookCover,
	args: { title: "Walden", provisional: true },
	render: (args) => (
		<div style={{ width: 160 }}>
			<BookCover {...args} />
		</div>
	),
};

export default meta;
type Story = StoryObj<typeof BookCover>;

const invalidImage = "data:image/png;base64,aW52YWxpZA==";
const noop = () => {};
const sampleArtwork = (width: number, height: number) =>
	`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#e4c28d"/><rect x="4" y="4" width="${width - 8}" height="${height - 8}" fill="none" stroke="#65462e" stroke-width="6"/><text x="18" y="44" fill="#38271b" font-family="Georgia,serif" font-size="22">A Book of Stories</text><circle cx="${width - 28}" cy="${height - 28}" r="18" fill="#936442"/></svg>`)}`;

/**
 * A transparent image the size of a thumbnail: a stand-in for a cover that
 * has not arrived yet, so what shows is the placeholder behind it.
 */
const STILL_LOADING = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"/>',
)}`;

/** What citadel-core's cover_colors gives each of these covers. */
const PLACEHOLDER_COVERS: { title: string; colors: CoverColors | null }[] = [
	{
		// Solid rgb(40, 80, 120), the hash pinned in the Rust and TS tests.
		title: "ThumbHash: solid blue",
		colors: {
			palette: {
				dominant: {
					l: 0.42183394548483344,
					a: -0.027271714012120363,
					b: -0.07619850732504196,
					share: 1,
				},
				secondary: null,
			},
			thumbhash: "FLYBBQCGhnh4h4iHd3eH9weH+Ed4",
		},
	},
	{
		// Red over an amber band.
		title: "ThumbHash: red and amber",
		colors: {
			palette: {
				dominant: {
					l: 0.37040097804771877,
					a: 0.1052925303324819,
					b: 0.050180778893390156,
					share: 0.6458333333333334,
				},
				secondary: {
					l: 0.6006462899528494,
					a: 0.04368352888135707,
					b: 0.06685143353256263,
					share: 0.3125,
				},
			},
			thumbhash: "U4kKDQSIh4CIuIiIiIaYiIeAi/hI",
		},
	},
	{
		// A green cover with no hash: the flat main colour.
		title: "Flat colour",
		colors: {
			palette: {
				dominant: {
					l: 0.37255154691263526,
					a: -0.0554444354341126,
					b: 0.009386526714990726,
					share: 0.6458333333333334,
				},
				secondary: null,
			},
			thumbhash: "",
		},
	},
	{ title: "No colours", colors: null },
];

/** Replays the production animation without remounting or reloading the cover. */
const AnimatedCover = ({
	exit,
	maxHeight = 200,
	...props
}: BookCoverProps & { exit: "added" | "skipped" }) => {
	const slot = useRef<HTMLDivElement>(null);
	const replay = async () => {
		const cover = slot.current?.firstElementChild;
		const image = cover?.querySelector("img");
		if (image) await image.decode().catch(() => undefined);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const animation = cover?.getAnimations()[0];
		if (!animation) return;
		animation.currentTime = 0;
		animation.onfinish = () => {
			animation.pause();
			animation.currentTime = 0;
		};
		animation.play();
	};
	return (
		<>
			<div className={showcase.slot} ref={slot}>
				<BookCover
					{...props}
					maxHeight={maxHeight}
					exit={exit}
					style={{ animationPlayState: "paused" }}
				/>
			</div>
			<button type="button" className={showcase.replay} onClick={replay}>
				Replay {exit}
			</button>
		</>
	);
};

const examples: {
	label: string;
	description: string;
	props: BookCoverProps;
}[] = [
	{
		label: "Ready",
		description: "Natural artwork, with the shared binding and shadow.",
		props: { src: artwork },
	},
	{
		label: "Selected",
		description: "Selection surrounds the artwork's actual shape.",
		props: { src: artwork, selected: true },
	},
	{
		label: "Finished",
		description: "The read overlay dims the complete cover.",
		props: { src: artwork, finished: true },
	},
	{
		label: "Selected + finished",
		description: "Selection and read state can be combined.",
		props: { src: artwork, selected: true, finished: true },
	},
	{
		label: "Interactive / hover",
		description: "Hover to lift the artwork and reveal a finished cover.",
		props: { src: artwork, finished: true, onPointerDown: noop },
	},
	{
		label: "Loading",
		description: "An unfetched book reserves its place on the shelf.",
		props: { loading: true },
	},
	{
		label: "Missing · titled",
		description: "A known title remains visible when artwork is missing.",
		props: { title: "A Book of Stories", authors: "An Author" },
	},
	{
		label: "Failed · titled",
		description: "An invalid image resolves to the same titled fallback.",
		props: {
			src: invalidImage,
			title: "A Book of Stories",
			authors: "An Author",
		},
	},
	{
		label: "Missing · untitled",
		description: "Upload/review keeps provisional titles out of the artwork.",
		props: { provisional: true, title: "Pending title" },
	},
	{
		label: "Failed · untitled",
		description: "An invalid upload image uses the untitled fallback too.",
		props: { src: invalidImage, provisional: true, title: "Pending title" },
	},
	{
		label: "Square",
		description: "The entire image stays visible; its frame stays square.",
		props: { src: sampleArtwork(240, 240) },
	},
	{
		label: "Landscape",
		description: "Wide artwork is shown without cropping its sides.",
		props: { src: sampleArtwork(360, 240) },
	},
	{
		label: "Very tall",
		description: "Tall artwork fits the height bound without stretching.",
		props: { src: sampleArtwork(100, 600) },
	},
	{
		label: "Small thumbnail",
		description: "The same renderer fits a 36 × 54 pixel slot.",
		props: { src: artwork, maxHeight: 54 },
	},
];

export const Overview: Story = {
	parameters: { layout: "fullscreen", controls: { disable: true } },
	render: () => (
		<main className={showcase.page}>
			<h1>BookCover · all states</h1>
			<p className={showcase.intro}>
				Each example has its own fixed slot. Actual artwork keeps its natural
				proportions; missing and failed images use either the titled or untitled
				fallback. Use the toolbar to switch themes. Exit samples start upright;
				Replay runs the complete animation.
			</p>
			<div className={showcase.examples}>
				{examples.map(({ label, description, props }) => (
					<section className={showcase.example} key={label}>
						<div className={showcase.slot}>
							<BookCover
								title="A Book of Stories"
								{...props}
								maxHeight={props.maxHeight ?? 200}
							/>
						</div>
						<h2>{label}</h2>
						<p>{description}</p>
					</section>
				))}
				{(["added", "skipped"] as const).map((exit) => (
					<section className={showcase.example} key={exit}>
						<AnimatedCover
							src={artwork}
							title="A Book of Stories"
							exit={exit}
						/>
						<h2>{exit === "added" ? "Added exit" : "Skipped exit"}</h2>
						<p>
							{exit === "added"
								? "Starts upright, lifts, turns and slides left."
								: "Shrinks slightly and drops as it fades."}
						</p>
					</section>
				))}
			</div>
		</main>
	),
};

/**
 * Grid covers mid-load: the decoded ThumbHash, then the flat main colour
 * when there is no hash, then today's look when there are no colours.
 */
export const LoadingPlaceholders: Story = {
	render: () => (
		<div style={{ display: "flex", gap: 24, alignItems: "flex-end" }}>
			{PLACEHOLDER_COVERS.map(({ title, colors }) => (
				<figure key={title} style={{ width: 150, margin: 0 }}>
					<BookCover
						src={STILL_LOADING}
						title={title}
						sizeHint={{ width: 300, height: 450 }}
						coverColors={colors}
					/>
					<figcaption style={{ fontSize: 12, marginTop: 8 }}>
						{title}
					</figcaption>
				</figure>
			))}
		</div>
	),
};

const TRANSITION_COVERS: {
	title: string;
	delayMs: number;
	loadBlob: () => Promise<Blob>;
	colors: CoverColors | null;
}[] = [
	{
		title: "ThumbHash → red & amber",
		delayMs: 700,
		loadBlob: async () =>
			new Blob(
				[
					'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="rgb(113,30,29)"/><rect y="300" width="300" height="150" fill="rgb(165,116,80)"/><text x="150" y="160" font-family="Georgia" font-size="30" fill="rgb(250,250,250)" text-anchor="middle">The Child &amp;</text><text x="150" y="200" font-family="Georgia" font-size="30" fill="rgb(250,250,250)" text-anchor="middle">Tchaikovsky</text></svg>',
				],
				{ type: "image/svg+xml" },
			),
		colors: {
			palette: {
				dominant: {
					l: 0.37175572917293687,
					a: 0.10497396584508839,
					b: 0.05014619512142994,
					share: 0.5950520833333334,
				},
				secondary: {
					l: 0.59876465336234,
					a: 0.04434968209395913,
					b: 0.06642488487884898,
					share: 0.3350694444444444,
				},
			},
			thumbhash: "VIkKDQRneICHp4hnh3anh4hwjPhH",
		},
	},
	{
		title: "ThumbHash → solid blue",
		delayMs: 1000,
		loadBlob: async () =>
			new Blob(
				[
					'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="rgb(40,80,120)"/><text x="150" y="210" font-family="Georgia" font-size="28" fill="rgb(245,248,252)" text-anchor="middle">Deep Water</text></svg>',
				],
				{ type: "image/svg+xml" },
			),
		colors: {
			palette: {
				dominant: {
					l: 0.42190913447465267,
					a: -0.02726785563104338,
					b: -0.07618908130273995,
					share: 0.9700520833333334,
				},
				secondary: null,
			},
			thumbhash: "FLYBBQAoh4l3CMdIp47TOCiJgJII",
		},
	},
	{
		title: "ThumbHash → photo 1",
		delayMs: 1300,
		loadBlob: async () => (await fetch(artwork1)).blob(),
		colors: {
			palette: {
				dominant: {
					l: 0.4389037645460883,
					a: -0.004930927133423695,
					b: 0.055480214067865415,
					share: 0.2048611111111111,
				},
				secondary: {
					l: 0.7005331982248137,
					a: -0.006447708608525677,
					b: 0.0016572025522014688,
					share: 0.1957465277777778,
				},
			},
			thumbhash: "3AgOHQJ4hn93d4doiHanh4lwmAmn",
		},
	},
	{
		title: "ThumbHash → photo 2",
		delayMs: 1600,
		loadBlob: async () => (await fetch(artwork)).blob(),
		colors: {
			palette: {
				dominant: {
					l: 0.39597388783652054,
					a: 0.01060983160090542,
					b: 0.03413375027444395,
					share: 0.3363715277777778,
				},
				secondary: {
					l: 0.2773557122041696,
					a: 0.015277177773968581,
					b: 0.022955695873304947,
					share: 0.2630208333333333,
				},
			},
			thumbhash: "WAgSHQR5iI+Hp4eHh3Z4h4VhQAgG",
		},
	},
	{
		title: "Flat colour → green",
		delayMs: 1900,
		loadBlob: async () =>
			new Blob(
				[
					'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="rgb(32,76,57)"/><text x="150" y="210" font-family="Georgia" font-size="28" fill="rgb(242,240,228)" text-anchor="middle">Forest Notes</text></svg>',
				],
				{ type: "image/svg+xml" },
			),
		colors: PLACEHOLDER_COVERS[2]?.colors ?? null,
	},
];

const ThumbhashToCoverDemo = () => {
	const [srcs, setSrcs] = useState<(string | null)[]>(() =>
		TRANSITION_COVERS.map(() => null),
	);
	const timersRef = useRef<number[]>([]);
	const blobUrlsRef = useRef<string[]>([]);
	const generationRef = useRef(0);

	const resetTimers = () => {
		for (const id of timersRef.current) window.clearTimeout(id);
		timersRef.current = [];
	};

	const revokeBlobs = () => {
		for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
		blobUrlsRef.current = [];
	};

	const reveal = async (index: number, generation: number) => {
		const item = TRANSITION_COVERS[index];
		if (!item) return;
		const blob = await item.loadBlob();
		if (generationRef.current !== generation) return;
		const url = URL.createObjectURL(blob);
		blobUrlsRef.current.push(url);
		setSrcs((prev) => prev.map((cur, i) => (i === index ? url : cur)));
	};

	const replay = () => {
		resetTimers();
		revokeBlobs();
		const generation = ++generationRef.current;
		setSrcs(TRANSITION_COVERS.map(() => null));
		timersRef.current = TRANSITION_COVERS.map((item, index) =>
			window.setTimeout(() => {
				void reveal(index, generation);
			}, item.delayMs),
		);
	};

	useEffect(() => {
		const generation = ++generationRef.current;
		timersRef.current = TRANSITION_COVERS.map((item, index) =>
			window.setTimeout(() => {
				void item.loadBlob().then((blob) => {
					if (generationRef.current !== generation) return;
					const url = URL.createObjectURL(blob);
					blobUrlsRef.current.push(url);
					setSrcs((prev) => prev.map((cur, i) => (i === index ? url : cur)));
				});
			}, item.delayMs),
		);
		return () => {
			generationRef.current++;
			for (const id of timersRef.current) window.clearTimeout(id);
			timersRef.current = [];
			for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
			blobUrlsRef.current = [];
		};
	}, []);

	const allLoaded = srcs.every((src) => src !== null);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" className={showcase.replay} onClick={replay}>
					Replay transition
				</button>
				<button
					type="button"
					className={showcase.replay}
					onClick={() => {
						resetTimers();
						revokeBlobs();
						const generation = ++generationRef.current;
						if (allLoaded) {
							setSrcs(TRANSITION_COVERS.map(() => null));
						} else {
							for (let i = 0; i < TRANSITION_COVERS.length; i++) {
								void reveal(i, generation);
							}
						}
					}}
				>
					{allLoaded ? "Show placeholders" : "Show covers"}
				</button>
			</div>
			<div style={{ display: "flex", gap: 24, alignItems: "flex-end" }}>
				{TRANSITION_COVERS.map(({ title, colors }, index) => {
					const coverSrc = srcs[index] ?? null;
					return (
						<figure key={title} style={{ width: 150, margin: 0 }}>
							<BookCover
								src={coverSrc ?? STILL_LOADING}
								title={title}
								sizeHint={{ width: 300, height: 450 }}
								coverColors={colors}
							/>
							<figcaption style={{ fontSize: 12, marginTop: 8 }}>
								{title} ({coverSrc ? "loaded" : "placeholder"})
							</figcaption>
						</figure>
					);
				})}
			</div>
		</div>
	);
};

/**
 * Simulates covers arriving over their ThumbHash / flat-colour placeholders
 * with a staggered delay and a Replay control.
 */
export const ThumbhashToCover: Story = {
	render: () => <ThumbhashToCoverDemo />,
};

/** Interactive: type a title to see its cover. */
export const Playground: Story = {};

const TITLES = [
	"Walden",
	"Kim",
	"Emma",
	"Dracula",
	"Persuasion",
	"Little Women",
	"Ulysses",
	"Beowulf",
	"The Odyssey",
	"Frankenstein",
	"Middlemarch",
	"Moby-Dick",
	"The Jungle Book",
	"Anne of Green Gables",
	"A Tale of Two Cities",
	"Great Expectations",
	"Jane Eyre",
	"Wuthering Heights",
	"Silas Marner",
	"The Secret Garden",
	"Treasure Island",
	"Heart of Darkness",
	"Bleak House",
	"Vanity Fair",
];

/** Static: a shelf of generated covers. */
export const Shelf: Story = {
	render: () => (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
				gap: 20,
			}}
		>
			{TITLES.map((title) => (
				<BookCover key={title} title={title} provisional />
			))}
		</div>
	),
};

export const Image: Story = {
	args: { src: new URL("../../assets/1.jpg", import.meta.url).href },
};
export const Loading: Story = { args: { loading: true } };
export const Selected: Story = { args: { selected: true } };
export const Finished: Story = {
	args: {
		src: new URL("../../assets/1.jpg", import.meta.url).href,
		finished: true,
	},
};

export const Added: Story = {
	render: (args) => <AnimatedCover {...args} exit="added" />,
	args: {
		src: new URL("../../assets/1.jpg", import.meta.url).href,
		exit: "added",
	},
};
export const Skipped: Story = {
	render: (args) => <AnimatedCover {...args} exit="skipped" />,
	args: {
		src: new URL("../../assets/1.jpg", import.meta.url).href,
		exit: "skipped",
	},
};

export const TitledFallback: Story = {
	args: {
		provisional: false,
		title: "A Book of Stories",
		authors: "An Author",
	},
};
