import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { HourglassStyle } from "@/components/atoms/Hourglass";
import { countdown } from "@/lib/uploads/countdown";
import { type QueueItem, UploadPhase } from "@/lib/uploads/queue";
import {
	inHours,
	sampleBook as book,
	sampleQueue,
} from "@/lib/uploads/story-fixtures";
import { UploadQueueRow } from "./UploadQueueRow";

const now = new Date();
const SAMPLE_ITEMS = sampleQueue(now);

const meta: Meta<typeof UploadQueueRow> = {
	component: UploadQueueRow,
	args: { hourglass: HourglassStyle.sand },
	argTypes: {
		hourglass: {
			control: "inline-radio",
			options: Object.values(HourglassStyle),
		},
	},
	decorators: [
		(Story) => (
			<ul
				style={{
					maxWidth: 480,
					margin: 0,
					padding: "0 20px",
					background: "var(--ctd-surface)",
					borderRadius: 10,
				}}
			>
				<Story />
			</ul>
		),
	],
};

export default meta;
type Story = StoryObj<typeof UploadQueueRow>;

/** Static: every phase a row can be in. */
export const EveryPhase: Story = {
	render: (args) => (
		<>
			{SAMPLE_ITEMS.map((item) => (
				<UploadQueueRow
					key={item.key}
					{...args}
					item={item}
					countdown={
						item.expiresAt
							? countdown(item.expiresAt, now, 24 * 3600)
							: undefined
					}
				/>
			))}
		</>
	),
};

const Lifecycle = (args: {
	hourglass?: (typeof HourglassStyle)[keyof typeof HourglassStyle];
}) => {
	const [item, setItem] = useState<QueueItem>({
		key: "live",
		name: "a-tale-of-two-cities",
		fileName: "a-tale-of-two-cities.epub",
		size: 100,
		phase: UploadPhase.waiting,
		sentBytes: 0,
		file: new File(["x"], "a-tale-of-two-cities.epub"),
	});
	useEffect(() => {
		const timer = setInterval(() => {
			setItem((current) => {
				switch (current.phase) {
					case UploadPhase.waiting:
						return { ...current, phase: UploadPhase.uploading };
					case UploadPhase.uploading:
						return current.sentBytes >= 100
							? { ...current, phase: UploadPhase.reading }
							: { ...current, sentBytes: current.sentBytes + 5 };
					case UploadPhase.reading:
						return {
							...current,
							phase: UploadPhase.ready,
							name: "A Tale of Two Cities",
							book: book("A Tale of Two Cities", "Charles Dickens"),
							expiresAt: inHours(24),
						};
					default:
						return current;
				}
			});
		}, 150);
		return () => clearInterval(timer);
	}, []);
	return (
		<UploadQueueRow
			{...args}
			item={item}
			countdown={
				item.expiresAt
					? countdown(item.expiresAt, new Date(), 24 * 3600)
					: undefined
			}
			onRemove={() =>
				setItem((current) => ({
					...current,
					phase: UploadPhase.waiting,
					sentBytes: 0,
				}))
			}
		/>
	);
};

/** Interactive: one file going from waiting to ready; stop it to start over. */
export const FromWaitingToReady: Story = {
	render: (args) => <Lifecycle {...args} />,
};
