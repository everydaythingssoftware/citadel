import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { summarize } from "@/lib/uploads/queue";
import { sampleQueue, staticDeck } from "@/lib/uploads/story-fixtures";
import { UploadSheet } from "./UploadSheet";

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

/** Static: reviewing the first ready book. */
export const Reviewing: Story = { args: { reviewing: true } };
