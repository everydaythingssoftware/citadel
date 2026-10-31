import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { HourglassStyle } from "@/components/atoms/Hourglass";
import { countdown } from "@/lib/uploads/countdown";
import { inHours } from "@/lib/uploads/story-fixtures";
import { UploadIndicator, type UploadIndicatorProps } from "./UploadIndicator";

const now = new Date();

const meta: Meta<typeof UploadIndicator> = {
	component: UploadIndicator,
	args: {
		summary: { active: 2, ready: 1, progress: 0.4, settled: false },
		hourglass: HourglassStyle.timer,
		onOpen: () => console.log("open"),
	},
	argTypes: {
		hourglass: {
			control: "inline-radio",
			options: Object.values(HourglassStyle),
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
