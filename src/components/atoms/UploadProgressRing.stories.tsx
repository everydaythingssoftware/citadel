import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import {
	UploadProgressRing,
	type UploadProgressRingProps,
} from "./UploadProgressRing";

const meta: Meta<typeof UploadProgressRing> = {
	component: UploadProgressRing,
	args: { progress: 0.62, size: 24, stopLabel: "Stop uploading walden" },
	argTypes: {
		progress: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
	},
};

export default meta;
type Story = StoryObj<typeof UploadProgressRing>;

/** Interactive: with a stop button; drag the progress. */
export const WithStop: Story = {
	args: { onStop: () => console.log("stop") },
};

/** Static: progress only, as an accessible progressbar. */
export const Steps: Story = {
	render: () => (
		<div style={{ display: "flex", gap: 16 }}>
			{[0, 0.1, 0.35, 0.62, 0.9, 1].map((progress) => (
				<UploadProgressRing key={progress} progress={progress} />
			))}
		</div>
	),
};

const Running = (args: UploadProgressRingProps) => {
	const [progress, setProgress] = useState(0);
	const [stopped, setStopped] = useState(false);
	useEffect(() => {
		if (stopped) return;
		const timer = setInterval(
			() => setProgress((value) => (value >= 1 ? 0 : value + 0.02)),
			80,
		);
		return () => clearInterval(timer);
	}, [stopped]);
	return (
		<div
			style={{
				display: "flex",
				gap: 12,
				alignItems: "center",
				color: "var(--ctd-ink)",
			}}
		>
			<UploadProgressRing
				{...args}
				progress={progress}
				onStop={() => setStopped((value) => !value)}
			/>
			<span style={{ fontSize: 13 }}>
				{stopped ? "Stopped (click to resume)" : "Uploading…"}
			</span>
		</div>
	);
};

/** Interactive: a running upload; click the ring to stop it. */
export const Uploading: Story = { render: (args) => <Running {...args} /> };
