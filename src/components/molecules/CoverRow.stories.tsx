import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "@/components/ui";
import { type CoverRowParams, DEFAULT_COVER_ROW } from "@/lib/cover-row";
import {
	CoverExit,
	type DepartingCover,
	LEAVE_MS,
	type TCoverExit,
} from "@/lib/hooks/use-review-deck";
import { type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import { sampleBook } from "@/lib/uploads/story-fixtures";
import { CoverRow } from "./CoverRow";

const TITLES = [
	"Moby-Dick",
	"Pride and Prejudice",
	"Walden",
	"Middlemarch",
	"Kim",
	"Emma",
	"Persuasion",
	"Dracula",
	"Ulysses",
	"Beloved",
	"Rebecca",
	"Frankenstein",
];

const books = (count: number): QueueItem[] =>
	Array.from({ length: count }, (_, index) => {
		const title = TITLES[index % TITLES.length] ?? "Untitled";
		const name = index < TITLES.length ? title : `${title} ${index}`;
		return {
			key: name,
			name,
			fileName: `${name}.epub`,
			size: 1,
			sentBytes: 1,
			phase: UploadPhase.ready,
			uploadId: String(index),
			book: sampleBook(name, "An Author"),
		};
	});

type TuneArgs = CoverRowParams & { books: number; width: number };

const Tuned = ({ books: count, width, ...params }: TuneArgs) => {
	const [items] = useState(() => books(count));
	const [index, setIndex] = useState(Math.floor(count / 2));
	const item = items[index];
	return (
		<div style={{ width, display: "grid", gap: 12, color: "var(--ctd-ink)" }}>
			<CoverRow
				items={items}
				index={index}
				params={params}
				onSelect={setIndex}
			/>
			<p style={{ margin: 0, textAlign: "center", fontSize: 13 }}>
				{item?.name} · {index + 1} of {items.length}
			</p>
			<p style={{ margin: 0, fontSize: 12, color: "var(--ctd-ink-soft)" }}>
				Swipe sideways on a trackpad (a flick spins through several), drag, or
				click a cover. The title below updates the moment a cover reaches the
				middle. Tune it with the controls; the defaults are what the app uses.
			</p>
		</div>
	);
};

const meta: Meta<TuneArgs> = {
	title: "molecules/CoverRow",
	args: { ...DEFAULT_COVER_ROW, books: 12, width: 520 },
	argTypes: {
		coverWidth: { control: { type: "range", min: 64, max: 200, step: 4 } },
		peek: { control: { type: "range", min: 0, max: 0.8, step: 0.02 } },
		sideScale: { control: { type: "range", min: 0.5, max: 1, step: 0.01 } },
		pixelsPerCover: { control: { type: "range", min: 20, max: 400, step: 5 } },
		stiffness: { control: { type: "range", min: 40, max: 800, step: 10 } },
		edgeResistance: { control: { type: "range", min: 0, max: 1, step: 0.05 } },
		books: { control: { type: "range", min: 1, max: 40, step: 1 } },
		width: { control: { type: "range", min: 320, max: 1000, step: 10 } },
	},
};

export default meta;
type Story = StoryObj<TuneArgs>;

/** Interactive: every parameter as a control. Changing "books" needs a remount (reload the story). */
export const Tune: Story = { render: (args) => <Tuned {...args} /> };

const Live = () => {
	const [items, setItems] = useState(() => books(8));
	const [index, setIndex] = useState(2);
	const [departing, setDeparting] = useState<DepartingCover>();
	const leave = (exit: TCoverExit) => {
		const item = items[index];
		if (!item) return;
		setDeparting({ item, index, exit, last: items.length === 1 });
		setItems((current) => current.filter((book) => book.key !== item.key));
		setIndex((current) => Math.min(current, items.length - 2));
		setTimeout(() => setDeparting(undefined), LEAVE_MS);
	};
	return (
		<div style={{ width: 520, display: "grid", gap: 12 }}>
			<CoverRow
				items={items}
				index={Math.max(0, index)}
				departing={departing}
				onSelect={setIndex}
			/>
			<div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
				<Button onClick={() => leave(CoverExit.skipped)}>Skip</Button>
				<Button variant="primary" onClick={() => leave(CoverExit.added)}>
					Add to Library
				</Button>
				<Button
					onClick={() => {
						setItems(books(8));
						setIndex(2);
					}}
				>
					Reset
				</Button>
			</div>
		</div>
	);
};

/** Interactive: add or skip; the cover leaves and the next glides into the middle. */
export const AddingAndSkipping: Story = { render: () => <Live /> };
