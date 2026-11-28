import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { useReviewDeck } from "@/lib/hooks/use-review-deck";
import { useMatchChoice } from "@/lib/hooks/use-review-matches";
import type { BookMatch } from "@/lib/services/library";
import { type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import { inHours, sampleBook, staticDeck } from "@/lib/uploads/story-fixtures";
import { UploadReview } from "./UploadReview";

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

const Deck = () => {
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
					display: "flex",
					height: 700,
					overflow: "hidden",
					background: "var(--ctd-surface)",
					borderRadius: 10,
					border: "1px solid var(--ctd-border)",
				}}
			>
				<UploadReview
					deck={deck}
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
			<ul
				style={{
					fontSize: "var(--ctd-text-callout)",
					color: "var(--ctd-ink-soft)",
					margin: 0,
				}}
			>
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
};

export default meta;
type Story = StoryObj<typeof Deck>;

/** Interactive: page with ‹ › or the arrow keys, then add or skip. */
export const Reviewing: Story = {};

/** Static: the last ready book. */
export const LastBook: Story = {
	render: () => (
		<div
			style={{
				maxWidth: 520,
				display: "flex",
				height: 640,
				background: "var(--ctd-surface)",
				borderRadius: 10,
			}}
		>
			<UploadReview
				onBack={() => {}}
				deck={staticDeck(readyItems().slice(0, 1))}
			/>
		</div>
	),
};

const GERMINAL: BookMatch = {
	id: "g",
	title: "Moby-Dick",
	authorNames: ["Herman Melville"],
	formats: ["MOBI", "PDF"],
	isbn: "978-0-14-243724-7",
	added: "2024-03-03",
	coverUrl: null,
	reason: "isbn",
};

const OTHER: BookMatch = {
	...GERMINAL,
	id: "h",
	formats: ["EPUB"],
	isbn: null,
	added: "2022-01-12",
	reason: "titleAndAuthor",
};

const WithMatches = ({
	matches,
	formats = ["EPUB"],
}: {
	matches: BookMatch[];
	formats?: string[];
}) => {
	const items = readyItems().slice(0, 1);
	const deck = staticDeck(items);
	const choice = useMatchChoice({
		bookKey: deck.current?.key,
		staged: matches,
		matches,
		formats,
	});
	return (
		<div
			style={{
				maxWidth: 520,
				display: "flex",
				height: 680,
				background: "var(--ctd-surface)",
				borderRadius: 10,
			}}
		>
			<UploadReview
				onBack={() => {}}
				deck={deck}
				matches={matches}
				choice={choice}
				formats={formats}
				files={formats.map((format, index) => ({
					key: format,
					format,
					fileName:
						index === 0
							? `germinal.${format.toLowerCase()}`
							: `Germinal - Émile Zola (Penguin Classics, 2004).${format.toLowerCase()}`,
				}))}
				onSplit={formats.length > 1 ? () => {} : undefined}
			/>
		</div>
	);
};

/** A possible duplicate: the same book by default; or answer that it's a different one. */
export const PossibleDuplicate: Story = {
	render: () => <WithMatches matches={[GERMINAL]} />,
};

/** Two matches to choose between; one already has an EPUB, so choosing it replaces it. */
export const SeveralMatches: Story = {
	render: () => <WithMatches matches={[GERMINAL, OTHER]} />,
};

/** One book from two files, which can be split. */
export const TwoFormats: Story = {
	render: () => <WithMatches matches={[]} formats={["EPUB", "MOBI"]} />,
};
