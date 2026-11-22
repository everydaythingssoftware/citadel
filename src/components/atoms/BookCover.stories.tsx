import type { Meta, StoryObj } from "@storybook/react";
import { useRef } from "react";
import { BookCover, type BookCoverProps } from "./BookCover";
import showcase from "./BookCover.stories.module.css";
import artwork from "../../assets/2.jpg";

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
