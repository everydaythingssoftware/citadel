import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { fn } from "storybook/test";
import { create } from "zustand";
import { Button } from "@/components/ui";
import { useReviewDeck } from "@/lib/hooks/use-review-deck";
import { useLiveMatches, useMatchChoice } from "@/lib/hooks/use-review-matches";
import type { BookMatch } from "@/lib/services/library";
import { createFakeUploads } from "@/lib/uploads/fake-uploads";
import {
	emptyQueue,
	type QueueState,
	queueReducer,
	queueSections,
	readyItems,
	reviewRows,
	rowFormats,
	summarize,
	visibleItems,
} from "@/lib/uploads/queue";
import { createUploadRunner } from "@/lib/uploads/runner";
import { sampleQueue, staticDeck } from "@/lib/uploads/story-fixtures";
import { UploadSheet } from "./UploadSheet";

const now = new Date();
const QUEUE = sampleQueue(now);

const match = (
	id: string,
	title: string,
	authorNames: string[],
	formats: string[],
	reason: BookMatch["reason"],
	isbn: string | null = null,
): BookMatch => ({
	id,
	title,
	authorNames,
	formats,
	isbn,
	added: "2024-03-03",
	coverUrl: null,
	reason,
});

/** The library the stories' books are checked against. */
const LIBRARY: Record<string, BookMatch[]> = {
	germinal: [
		match(
			"g",
			"Germinal",
			["Émile Zola"],
			["MOBI", "PDF"],
			"isbn",
			"978-0-14-044742-4",
		),
	],
	"the odyssey": [
		match("o1", "The Odyssey", ["Homer"], ["MOBI"], "titleAndAuthor"),
		match(
			"o2",
			"The Odyssey",
			["Homer", "Robert Fagles"],
			["EPUB", "PDF"],
			"titleAndAuthor",
			"978-0-14-026886-7",
		),
	],
	"dungeon crawler carl, book 15: the plague of misanthropes": [
		match(
			"d",
			"Dungeon Crawler Carl, Book 15: The Plague of Misanthropes",
			["Matt Dinniman"],
			["AZW3"],
			"titleAndAuthor",
		),
	],
	poems: [match("p", "Poems", [], ["PDF"], "title")],
};

const BOOKS: Record<string, string[]> = {
	middlemarch: ["George Eliot"],
	walden: ["Henry David Thoreau"],
	kim: ["Rudyard Kipling"],
	emma: ["Jane Austen"],
	"pride and prejudice": ["Jane Austen"],
	"moby-dick": ["Herman Melville"],
	"war and peace": ["Leo Tolstoy"],
	"the age of innocence": ["Edith Wharton"],
	"a room with a view": ["E. M. Forster"],
	ulysses: ["James Joyce"],
	"heart of darkness": ["Joseph Conrad"],
	"the picture of dorian gray": ["Oscar Wilde"],
	germinal: ["Émile Zola"],
	"the odyssey": ["Homer"],
	"dungeon crawler carl, book 15: the plague of misanthropes": [
		"Matt Dinniman",
	],
	poems: [],
};

const titleCase = (name: string) =>
	name.replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase());

const describe = (fileName: string) => {
	const name = fileName.replace(/\.[^.]+$/, "").toLowerCase();
	return { title: titleCase(name), authorNames: BOOKS[name] ?? [] };
};

const FILES = [
	"middlemarch.epub",
	"middlemarch.mobi",
	"walden.epub",
	"kim.pdf",
	"germinal.epub",
	"emma.epub",
	"pride and prejudice.epub",
	"the odyssey.epub",
	"moby-dick.azw3",
	"war and peace.epub",
	"the age of innocence.epub",
	"dungeon crawler carl, book 15: the plague of misanthropes.epub",
	"a room with a view.epub",
	"ulysses.epub",
	"heart of darkness.mobi",
	"the picture of dorian gray.epub",
	"poems.pdf",
];

const pause = (ms: number) => () =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The real sheet driven by the real queue, runner and review, against an
 * in-memory server whose library holds a few of the books already.
 */
const Interactive = ({ files }: { files: string[] }) => {
	const harness = useMemo(() => {
		const fake = createFakeUploads({
			withCovers: false,
			describe,
			matchesFor: (title) => LIBRARY[title.trim().toLowerCase()] ?? [],
			chunkDelay: pause(60),
			readDelay: pause(120),
		});
		const store = create<{ queue: QueueState }>(() => ({ queue: emptyQueue }));
		const runner = createUploadRunner({
			uploads: fake.uploads,
			getState: () => store.getState().queue,
			dispatch: (action) =>
				store.setState(({ queue }) => ({ queue: queueReducer(queue, action) })),
		});
		return { fake, store, runner };
	}, []);
	const { store, runner, fake } = harness;
	const queue = store((state) => state.queue);
	const [open, setOpen] = useState(true);
	const [reviewKey, setReviewKey] = useState<string | null>(null);

	const start = () => {
		store.setState({ queue: emptyQueue });
		setReviewKey(null);
		runner.addFiles(files.map((name) => new File(["0123456789abcdef"], name)));
		setOpen(true);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
	useEffect(start, []);

	const sections = queueSections(queue);
	const rows = reviewRows(queue);
	const ready = rows.map((row) => row.lead);
	const settle = () => {
		const state = store.getState().queue;
		if (visibleItems(state).length === 0) setOpen(false);
		else if (readyItems(state).length === 0) setReviewKey(null);
	};
	const deck = useReviewDeck({
		ready,
		reviewKey,
		setReviewKey,
		onAdd: async (key, book) => {
			const added = await runner.add(key, book);
			if (added) settle();
			return added;
		},
		onSkip: async (key) => {
			await runner.skip(key);
			settle();
		},
		keyboard: open && reviewKey !== null,
	});
	const currentRow = rows.find((row) => row.key === deck.current?.key);
	const formats = currentRow ? rowFormats(currentRow) : [];
	const staged = currentRow?.matches ?? [];
	const matches = useLiveMatches({
		intake: fake.uploads,
		bookKey: deck.current?.key,
		form: deck.form,
		staged,
	});
	const choice = useMatchChoice({
		bookKey: deck.current?.key,
		staged,
		matches,
		formats,
	});

	return (
		<div style={{ padding: 16 }}>
			<Button onClick={start}>Start Over</Button>
			<UploadSheet
				open={open}
				onOpenChange={setOpen}
				sections={sections}
				summary={summarize(queue)}
				reviewing={reviewKey !== null}
				deck={deck}
				matches={matches}
				choice={choice}
				formats={formats}
				onSplit={
					currentRow && currentRow.items.length > 1
						? () =>
								store.setState(({ queue: state }) => ({
									queue: queueReducer(state, {
										type: "split",
										keys: currentRow.items.map((item) => item.key),
									}),
								}))
						: undefined
				}
				onChooseFiles={fn()}
				onReview={setReviewKey}
				onReviewBooks={() => setReviewKey(rows[0]?.key ?? null)}
				onBackToQueue={() => setReviewKey(null)}
				onRetry={(key) => runner.retry(key)}
				onRemove={(key) => void runner.remove(key)}
				onAddNewBooks={() => void runner.addNewBooks().then(settle)}
				onDiscardAll={() => {
					for (const item of visibleItems(store.getState().queue))
						void runner.remove(item.key);
					setOpen(false);
				}}
			/>
		</div>
	);
};

const meta: Meta<typeof UploadSheet> = {
	component: UploadSheet,
	args: {
		open: true,
		onOpenChange: fn(),
		sections: queueSections({ items: QUEUE }),
		summary: summarize({ items: QUEUE }),
		reviewing: false,
		deck: staticDeck(QUEUE),
		onChooseFiles: fn(),
		onReview: fn(),
		onReviewBooks: fn(),
		onBackToQueue: fn(),
		onRetry: fn(),
		onRemove: fn(),
		onAddNewBooks: fn(),
		onDiscardAll: fn(),
	},
	parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof UploadSheet>;

/**
 * Interactive: 17 files upload, read and sort themselves — an EPUB and MOBI
 * of Middlemarch become one book, and four possible duplicates wait at the
 * bottom. Click a book or Review Books; Add New Books adds the rest. Switch
 * the viewport to a phone for the full-screen layout.
 */
export const AddingBooks: Story = {
	render: () => <Interactive files={FILES} />,
};

/** Interactive: a short list, to see the sheet size itself. */
export const AFewBooks: Story = {
	render: () => (
		<Interactive files={["walden.epub", "germinal.epub", "kim.pdf"]} />
	),
};

/** Static: a queue with every kind of row. */
export const Queue: Story = {};

/** Static: nothing chosen yet. */
export const Empty: Story = {
	args: {
		sections: { books: [], possibleDuplicates: [] },
		summary: summarize({ items: [] }),
	},
};

/** Static: the server is full until some books are added or skipped. */
export const Paused: Story = {
	args: { paused: "Add or skip some books to keep uploading." },
};
