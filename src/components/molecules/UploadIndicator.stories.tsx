import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { countdown, describeDeadline } from "@/lib/uploads/countdown";
import { inHours } from "@/lib/uploads/story-fixtures";
import {
	ReviewIndicatorStyle,
	type TReviewIndicatorStyle,
	UploadIndicator,
	type UploadIndicatorProps,
} from "./UploadIndicator";

const now = new Date();
const READY = { active: 0, ready: 3, progress: 1, settled: true };

const meta: Meta<typeof UploadIndicator> = {
	component: UploadIndicator,
	args: {
		summary: { active: 2, ready: 1, progress: 0.4, settled: false },
		variant: ReviewIndicatorStyle.drafts,
		onOpen: () => console.log("open"),
	},
	argTypes: {
		variant: {
			control: "select",
			options: Object.values(ReviewIndicatorStyle),
		},
	},
};

export default meta;
type Story = StoryObj<typeof UploadIndicator>;

/** Static: the states the toolbar can show. */
export const States: Story = {
	render: (args) => (
		<div
			style={{
				display: "flex",
				gap: 12,
				flexWrap: "wrap",
				alignItems: "center",
			}}
		>
			<UploadIndicator
				{...args}
				summary={{ active: 3, ready: 0, progress: 0.25, settled: false }}
			/>
			<UploadIndicator
				{...args}
				summary={{ active: 0, ready: 4, progress: 1, settled: true }}
				countdown={countdown(inHours(20, now), now, 24 * 3600)}
			/>
			<UploadIndicator
				{...args}
				summary={{ active: 0, ready: 1, progress: 1, settled: true }}
				countdown={countdown(inHours(2, now), now, 24 * 3600)}
			/>
		</div>
	),
};

const OPTIONS: { variant: TReviewIndicatorStyle; idea: string }[] = [
	{
		variant: ReviewIndicatorStyle.drafts,
		idea: "Two pages waiting; pairs with “Drafts kept until…”.",
	},
	{
		variant: ReviewIndicatorStyle.tray,
		idea: "An in-tray: something to deal with, like Mail.",
	},
	{
		variant: ReviewIndicatorStyle.books,
		idea: "Book spines waiting to be shelved.",
	},
	{
		variant: ReviewIndicatorStyle.dot,
		idea: "Like an unread marker; pulses in the last stretch.",
	},
	{
		variant: ReviewIndicatorStyle.calendar,
		idea: "A calendar page showing the day the drafts go.",
	},
	{
		variant: ReviewIndicatorStyle.underline,
		idea: "No icon; the bottom edge drains as time passes.",
	},
	{
		variant: ReviewIndicatorStyle.fill,
		idea: "No icon; the background empties as time passes.",
	},
	{
		variant: ReviewIndicatorStyle.text,
		idea: "No icon; the time left, in words.",
	},
	{ variant: ReviewIndicatorStyle.timer, idea: "A stopwatch winding down." },
	{ variant: ReviewIndicatorStyle.sand, idea: "An hourglass draining." },
];

/**
 * Static: ten ways to say books are waiting, each with most of the day
 * left and in the last stretch (brass). Hover any for its tooltip.
 */
export const Options: Story = {
	render: () => (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "auto auto 1fr",
				gap: "14px 20px",
				alignItems: "center",
				color: "var(--ctd-ink)",
				fontSize: 13,
			}}
		>
			{OPTIONS.map(({ variant, idea }, index) => (
				<div key={variant} style={{ display: "contents" }}>
					<UploadIndicator
						variant={variant}
						summary={READY}
						countdown={countdown(inHours(18, now), now, 24 * 3600)}
						onOpen={() => {}}
					/>
					<UploadIndicator
						variant={variant}
						summary={READY}
						countdown={countdown(inHours(3, now), now, 24 * 3600)}
						onOpen={() => {}}
					/>
					<span style={{ color: "var(--ctd-ink-soft)" }}>
						{index + 1}. <strong>{variant}</strong>: {idea}
					</span>
				</div>
			))}
		</div>
	),
};

/** Static: ways to phrase the tooltip, all saying why the time matters. */
export const TooltipCopy: Story = {
	render: () => {
		const when = describeDeadline(new Date(inHours(18, now)), now);
		const lines = [
			`Drafts kept until ${when}`,
			`Kept until ${when}, then removed`,
			`Add or skip by ${when}; after that they're removed`,
			`Uploads you haven't added are removed ${when}`,
			`Waiting for you until ${when}`,
			`Saved for review until ${when}`,
		];
		return (
			<ol style={{ color: "var(--ctd-ink)", fontSize: 13, lineHeight: 2 }}>
				{lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ol>
		);
	},
};

const Live = (args: UploadIndicatorProps) => {
	const [progress, setProgress] = useState(0);
	useEffect(() => {
		const timer = setInterval(
			() => setProgress((value) => (value >= 1.4 ? 0 : value + 0.02)),
			80,
		);
		return () => clearInterval(timer);
	}, []);
	const uploading = progress < 1;
	return (
		<UploadIndicator
			{...args}
			summary={{
				active: uploading ? 2 : 0,
				ready: uploading ? 0 : 2,
				progress: Math.min(1, progress),
				settled: !uploading,
			}}
			countdown={countdown(inHours(23, now), now, 24 * 3600)}
		/>
	);
};

/** Interactive: uploads finishing, then waiting for review. */
export const Cycling: Story = { render: (args) => <Live {...args} /> };

const Draining = (args: UploadIndicatorProps) => {
	const [hours, setHours] = useState(24);
	useEffect(() => {
		const timer = setInterval(
			() => setHours((value) => (value <= 0.2 ? 24 : value - 0.4)),
			120,
		);
		return () => clearInterval(timer);
	}, []);
	return (
		<UploadIndicator
			{...args}
			summary={READY}
			countdown={countdown(inHours(hours, now), now, 24 * 3600)}
		/>
	);
};

/** Interactive: a whole day passing in seconds; pick a style in controls. */
export const DayPassing: Story = { render: (args) => <Draining {...args} /> };
