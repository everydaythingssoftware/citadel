import type { Meta, StoryObj } from "@storybook/react";
import { useReducer } from "react";
import { fn } from "storybook/test";
import {
	queueReducer,
	summarize,
	undecidedDuplicates,
	visibleItems,
} from "@/lib/uploads/queue";
import {
	sampleBook,
	sampleQueue,
	staticDeck,
} from "@/lib/uploads/story-fixtures";
import { UploadSheet, type UploadSheetProps } from "./UploadSheet";

const now = new Date();
const QUEUE = sampleQueue(now);

const meta: Meta<typeof UploadSheet> = {
	component: UploadSheet,
	args: {
		open: true,
		onOpenChange: fn(),
		items: QUEUE,
		summary: summarize({ items: QUEUE }),
		reviewing: false,
		deck: staticDeck(QUEUE),
		onChooseFiles: fn(),
		onReview: fn(),
		onBackToQueue: fn(),
		onRetry: fn(),
		onRemove: fn(),
		onSkipDuplicates: fn(),
		onAddDuplicates: fn(),
		onAddAll: fn(),
		onCancelAll: fn(),
	},
	parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof UploadSheet>;

/** Static: a queue with every kind of row. Resize to phone width for the full-screen layout. */
export const Queue: Story = {};

/** Static: nothing chosen yet. */
export const Empty: Story = {
	args: { items: [], summary: summarize({ items: [] }) },
};

/** Static: the server is full until some books are added or skipped. */
export const Paused: Story = {
	args: { paused: "Add or skip some books to keep uploading." },
};

const READ = QUEUE.slice(0, 2);
// Three copies of one book in the library, one of another, and three of a new
// book: its first copy is added with the rest, the other two asked about.
const DUPLICATES = [
	...[READ[0], READ[0], READ[0], READ[1]].map((item, index) => ({
		...(item ?? (undefined as never)),
		key: `library-${index}`,
		duplicate: {
			title: item?.name ?? "",
			message: `Already in your library: ${item?.name} by ${item?.book?.authorNames[0]}`,
		},
	})),
	...["Middlemarch", "Middlemarch", "Middlemarch"].map((title, index) => ({
		...(READ[0] ?? (undefined as never)),
		key: `read-${index}`,
		name: title,
		book: sampleBook(title, "George Eliot"),
	})),
];

const DuplicatesFirst = (args: UploadSheetProps) => {
	const [queue, dispatch] = useReducer(queueReducer, { items: DUPLICATES });
	return (
		<UploadSheet
			{...args}
			items={visibleItems(queue)}
			duplicates={undecidedDuplicates(queue)}
			summary={summarize(queue)}
			onSkipDuplicates={(items) => {
				for (const { key } of items) dispatch({ type: "removed", key });
			}}
			onAddDuplicates={(items) => {
				for (const { key } of items) dispatch({ type: "accepted", key });
			}}
		/>
	);
};

/** Interactive: duplicates are decided on before the rest of the queue. */
export const Duplicates: Story = {
	render: (args) => <DuplicatesFirst {...args} />,
};

/** Static: reviewing the first ready book. */
export const Reviewing: Story = { args: { reviewing: true } };
