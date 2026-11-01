import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "@/components/ui";
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

const meta: Meta<typeof CoverRow> = {
	title: "molecules/CoverRow",
	component: CoverRow,
};

export default meta;
type Story = StoryObj<typeof CoverRow>;

/** Static: the sixth of twelve books, its neighbours peeking in. */
export const Static: Story = {
	render: () => (
		<div style={{ width: 520 }}>
			<CoverRow items={books(12)} index={5} onSelect={() => {}} />
		</div>
	),
};

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

/**
 * Interactive: swipe on a trackpad, drag or click a cover; add or skip, and
 * the cover leaves and the next glides into the middle.
 */
export const AddingAndSkipping: Story = { render: () => <Live /> };
