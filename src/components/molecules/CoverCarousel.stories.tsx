import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
	CoverExit,
	type DepartingCover,
	LEAVE_MS,
} from "@/lib/hooks/use-review-deck";
import { type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import { sampleBook } from "@/lib/uploads/story-fixtures";
import { AddedMotion, CoverCarousel, type TAddedMotion } from "./CoverCarousel";

const TITLES = [
	"Moby-Dick",
	"Pride and Prejudice",
	"Walden",
	"Middlemarch",
	"Kim",
	"Emma",
];

const items = (): QueueItem[] =>
	TITLES.map((title, index) => ({
		key: title,
		name: title,
		fileName: `${title}.epub`,
		size: 1,
		sentBytes: 1,
		phase: UploadPhase.ready,
		uploadId: String(index),
		book: sampleBook(title, "An Author"),
	}));

const Live = ({ motion }: { motion: TAddedMotion }) => {
	const [books, setBooks] = useState(items);
	const [index, setIndex] = useState(1);
	const [departing, setDeparting] = useState<DepartingCover>();
	const remove = (exit: DepartingCover["exit"]) => {
		const item = books[index];
		if (!item) return;
		setDeparting({ item, index, exit });
		setBooks((current) => current.filter((book) => book.key !== item.key));
		setIndex((current) => (current < books.length - 1 ? current : current - 1));
		setTimeout(() => setDeparting(undefined), LEAVE_MS);
	};
	return (
		<div style={{ display: "grid", gap: 16, maxWidth: 520 }}>
			<CoverCarousel
				items={books}
				index={index}
				departing={departing}
				motion={motion}
				onSelect={setIndex}
			/>
			<p style={{ margin: 0, textAlign: "center", color: "var(--ctd-ink)" }}>
				{books[index]?.name ?? "None left"} · {index + 1} of {books.length}
			</p>
			<div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
				<button type="button" onClick={() => remove(CoverExit.skipped)}>
					Skip
				</button>
				<button type="button" onClick={() => remove(CoverExit.added)}>
					Add
				</button>
				<button
					type="button"
					onClick={() => {
						setBooks(items());
						setIndex(1);
					}}
				>
					Reset
				</button>
			</div>
		</div>
	);
};

const meta: Meta<typeof Live> = {
	title: "molecules/CoverCarousel",
	component: Live,
	args: { motion: AddedMotion.deal },
	argTypes: {
		motion: { control: "inline-radio", options: Object.values(AddedMotion) },
	},
};

export default meta;
type Story = StoryObj<typeof Live>;

/** Interactive: swipe or tap a neighbour; Add and Skip send the cover off. */
export const Deal: Story = {};

/** Interactive: added covers drop and shrink away. */
export const Shelve: Story = { args: { motion: AddedMotion.shelve } };

/** Interactive: added covers lift up and away. */
export const Lift: Story = { args: { motion: AddedMotion.lift } };

/** Static: the second of six books, neighbours either side. */
export const Static: Story = {
	render: () => <CoverCarousel items={items()} index={1} onSelect={() => {}} />,
};
