import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { useReviewDeck } from "@/lib/hooks/use-review-deck";
import { type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import { inHours, sampleBook } from "@/lib/uploads/story-fixtures";
import { AddedMotion, type TAddedMotion, UploadReview } from "./UploadReview";

const TITLES: [string, string][] = [
	["Moby-Dick", "Herman Melville"],
	["Pride and Prejudice", "Jane Austen"],
	["Walden", "Henry David Thoreau"],
	["Middlemarch", "George Eliot"],
	["Kim", "Rudyard Kipling"],
];

const readyItems = (): QueueItem[] =>
	TITLES.map(([title, author], index) => ({
		key: String(index),
		name: title,
		fileName: `${title}.epub`,
		size: 10,
		sentBytes: 10,
		uploadId: `staged-${index}`,
		phase: UploadPhase.ready,
		book: sampleBook(title, author),
		expiresAt: inHours(20),
	}));

const Deck = ({ motion }: { motion: TAddedMotion }) => {
	const [items, setItems] = useState(readyItems);
	const [reviewKey, setReviewKey] = useState<string | null>("0");
	const [log, setLog] = useState<string[]>([]);
	const deck = useReviewDeck({
		ready: items,
		reviewKey,
		setReviewKey,
		onAdd: async (key, book) => {
			setItems((current) =>
				current.map((item) =>
					item.key === key ? { ...item, phase: UploadPhase.adding } : item,
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 400));
			setItems((current) => current.filter((item) => item.key !== key));
			setLog((current) => [`Added “${book.title}”`, ...current]);
			return true;
		},
		onSkip: async (key) => {
			setItems((current) => current.filter((item) => item.key !== key));
			setLog((current) => [`Skipped ${key}`, ...current]);
		},
	});
	return (
		<div style={{ display: "grid", gap: 16, maxWidth: 520 }}>
			<div
				style={{
					padding: 20,
					background: "var(--ctd-surface)",
					borderRadius: 10,
					border: "1px solid var(--ctd-border)",
				}}
			>
				<UploadReview
					deck={deck}
					motion={motion}
					onBack={() => setLog((current) => ["Back to queue", ...current])}
				/>
			</div>
			<button
				type="button"
				onClick={() => {
					setItems(readyItems());
					setReviewKey("0");
					setLog([]);
				}}
				style={{ justifySelf: "start" }}
			>
				Reset
			</button>
			<ul style={{ fontSize: 12, color: "var(--ctd-ink-soft)", margin: 0 }}>
				{log.map((entry, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
					<li key={index}>{entry}</li>
				))}
			</ul>
		</div>
	);
};

const meta: Meta<typeof Deck> = {
	component: Deck,
	title: "molecules/UploadReview",
	args: { motion: AddedMotion.deal },
	argTypes: {
		motion: { control: "inline-radio", options: Object.values(AddedMotion) },
	},
};

export default meta;
type Story = StoryObj<typeof Deck>;

/** Interactive: page with ‹ › or the arrow keys, then add or skip. Default motion. */
export const Deal: Story = {};

/** Interactive: added books drop and shrink into the footer. */
export const Shelve: Story = { args: { motion: AddedMotion.shelve } };

/** Interactive: added books lift up and away. */
export const Lift: Story = { args: { motion: AddedMotion.lift } };

/** Static: the last ready book. */
export const LastBook: Story = {
	render: () => {
		const [item] = readyItems();
		return (
			<div
				style={{
					maxWidth: 520,
					padding: 20,
					background: "var(--ctd-surface)",
					borderRadius: 10,
				}}
			>
				<UploadReview
					onBack={() => {}}
					deck={{
						current: item,
						index: 0,
						count: 1,
						form: {
							title: "Moby-Dick",
							authors: ["Herman Melville"],
							publisher: "",
							language: "en",
							tags: [],
							publicationDate: "",
							identifier: "",
						},
						updateForm: () => {},
						leaving: undefined,
						entered: undefined,
						canPrevious: false,
						canNext: false,
						previous: () => {},
						next: () => {},
						add: async () => {},
						skip: async () => {},
						swipe: {
							onPointerDown: () => {},
							onPointerUp: () => {},
							onPointerCancel: () => {},
						},
					}}
				/>
			</div>
		);
	},
};
