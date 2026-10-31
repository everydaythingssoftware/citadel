import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { HourglassStyle } from "@/components/atoms/Hourglass";
import { CoverFanStyle } from "@/components/molecules/CoverFan";
import { DropOverlay } from "@/components/molecules/DropOverlay";
import { UploadIndicator } from "@/components/molecules/UploadIndicator";
import { AddedMotion } from "@/components/molecules/UploadReview";
import { Button } from "@/components/ui";
import { useFileDrag } from "@/lib/hooks/use-file-drag";
import { useNow } from "@/lib/hooks/use-now";
import { type ReviewDeck, useReviewDeck } from "@/lib/hooks/use-review-deck";
import { countdown } from "@/lib/uploads/countdown";
import { createWebPlatform } from "@/lib/platform/create";
import { createFakeUploads } from "@/lib/uploads/fake-uploads";
import {
	BOOK_EXTENSIONS,
	type QueueItem,
	readyItems,
	summarize,
	UploadPhase,
	visibleItems,
} from "@/lib/uploads/queue";
import { formForBook } from "@/lib/uploads/review";
import { sampleQueue } from "@/lib/uploads/story-fixtures";
import { useUploadsStore } from "@/stores/uploads/store";
import { UploadSheet, type UploadSheetProps } from "./UploadSheet";

const now = new Date();
const QUEUE = sampleQueue(now);

const staticDeck = (items: QueueItem[]): ReviewDeck => {
	const ready = items.filter((item) => item.phase === UploadPhase.ready);
	const [current] = ready;
	return {
		current,
		index: 0,
		count: ready.length,
		form: formForBook(current?.book),
		updateForm: () => {},
		leaving: undefined,
		entered: undefined,
		canPrevious: false,
		canNext: ready.length > 1,
		previous: () => {},
		next: () => {},
		add: async () => {},
		skip: async () => {},
		swipe: {
			onPointerDown: () => {},
			onPointerUp: () => {},
			onPointerCancel: () => {},
		},
	};
};

const noop = () => {};

const meta: Meta<typeof UploadSheet> = {
	component: UploadSheet,
	args: {
		open: true,
		onOpenChange: noop,
		items: QUEUE,
		summary: summarize({ items: QUEUE }),
		countdownFor: (item) =>
			item.phase === UploadPhase.ready && item.expiresAt
				? countdown(item.expiresAt, now, 24 * 3600)
				: undefined,
		hourglass: HourglassStyle.sand,
		reviewing: false,
		deck: staticDeck(QUEUE),
		motion: AddedMotion.deal,
		onChooseFiles: noop,
		onReview: noop,
		onBackToQueue: noop,
		onRetry: noop,
		onRemove: noop,
		onAddAll: noop,
		onCancelAll: noop,
	},
	argTypes: {
		hourglass: {
			control: "inline-radio",
			options: Object.values(HourglassStyle),
		},
		motion: { control: "inline-radio", options: Object.values(AddedMotion) },
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

/* --- A working queue against an in-memory server. --- */

const sampleFiles = (round: number) =>
	[
		["Moby-Dick.epub", 900_000],
		["Pride and Prejudice.mobi", 400_000],
		["Walden.azw3", 600_000],
		["Middlemarch.epub", 1_200_000],
		["A Very Large Atlas.pdf", 21 * 1024 * 1024],
		["Shopping list.docx", 1_000],
	].map(
		([name, size]) =>
			new File(
				[new Uint8Array(Number(size))],
				round === 0 ? String(name) : `${round}-${name}`,
			),
	);

const pause = (ms: number) => () =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const LiveQueue = (args: UploadSheetProps) => {
	const fake = useMemo(
		() =>
			createFakeUploads({
				limits: {
					chunkBytes: 256 * 1024,
					maxFileBytes: 20 * 1024 * 1024,
					reviewSeconds: 120,
				},
				chunkDelay: pause(150),
				readDelay: pause(1200),
				withCovers: false,
			}),
		[],
	);
	const store = useUploadsStore;
	const queue = store((state) => state.queue);
	const open = store((state) => state.sheetOpen);
	const reviewKey = store((state) => state.reviewKey);
	const [round, setRound] = useState(0);
	const clock = useNow(1000);
	const platform = useMemo(createWebPlatform, []);
	const chooseFiles = () =>
		void platform.dialogs
			.chooseFiles({ extensions: BOOK_EXTENSIONS, multiple: true })
			.then((files) => store.getState().addFiles(files));

	useEffect(() => {
		store.getState().connect(fake.uploads, noop);
		store.getState().openSheet();
		return () => store.getState().connect(undefined, noop);
	}, [fake]);

	const dragging = useFileDrag({
		enabled: true,
		onDrop: (files) => store.getState().addFiles(files),
	});
	const ready = readyItems(queue);
	const deck = useReviewDeck({
		ready,
		reviewKey,
		setReviewKey: (key) => store.getState().review(key),
		onAdd: (key, book) => store.getState().add(key, book),
		onSkip: (key) => store.getState().remove(key),
		keyboard: open && reviewKey !== null,
	});
	const summary = summarize(queue);
	const countdownFor = (item: QueueItem) =>
		item.phase === UploadPhase.ready && item.expiresAt
			? countdown(item.expiresAt, clock, queue.limits?.reviewSeconds ?? 120)
			: undefined;
	const soonest = ready.map(countdownFor).find(Boolean);

	return (
		<div
			style={{
				minHeight: "100vh",
				padding: 16,
				display: "grid",
				alignContent: "start",
				gap: 12,
				color: "var(--ctd-ink)",
			}}
		>
			<div
				style={{
					display: "flex",
					gap: 8,
					alignItems: "center",
					flexWrap: "wrap",
				}}
			>
				<Button
					variant="primary"
					onClick={() => {
						store.getState().addFiles(sampleFiles(round));
						setRound((value) => value + 1);
					}}
				>
					Add Sample Books
				</Button>
				<Button onClick={chooseFiles}>Choose Books…</Button>
				<Button onClick={() => store.getState().openSheet()}>Open Sheet</Button>
				<UploadIndicator
					summary={summary}
					countdown={soonest}
					hourglass={args.hourglass}
					onOpen={() => store.getState().openSheet()}
				/>
				<span style={{ fontSize: 12 }}>
					Or drag real files onto the page. Reviews here expire after two
					minutes.
				</span>
			</div>
			<DropOverlay visible={dragging} fan={CoverFanStyle.paintings} />
			<UploadSheet
				{...args}
				open={open}
				onOpenChange={(next) =>
					next ? store.getState().openSheet() : store.getState().closeSheet()
				}
				items={visibleItems(queue)}
				summary={summary}
				paused={queue.paused}
				countdownFor={countdownFor}
				reviewing={reviewKey !== null && ready.length > 0}
				deck={deck}
				onChooseFiles={chooseFiles}
				onReview={(key) => store.getState().review(key)}
				onBackToQueue={() => store.getState().review(null)}
				onRetry={(key) => store.getState().retry(key)}
				onRemove={(key) => void store.getState().remove(key)}
				onAddAll={() => void store.getState().addAllReady()}
				onCancelAll={() => {
					for (const item of visibleItems(queue))
						void store.getState().remove(item.key);
				}}
			/>
		</div>
	);
};

/**
 * Interactive: the real queue and runner against an in-memory server. Files
 * upload in chunks, get read, wait with a two-minute countdown, and can be
 * reviewed, added or skipped. Oversized and non-book files are rejected.
 */
export const LiveQueueStory: Story = {
	name: "Live queue",
	render: (args) => <LiveQueue {...args} />,
};
