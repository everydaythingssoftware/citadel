import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { countdown } from "@/lib/uploads/countdown";
import { Hourglass, type HourglassProps, HourglassStyle } from "./Hourglass";

const meta: Meta<typeof Hourglass> = {
	component: Hourglass,
	args: {
		fraction: 0.6,
		urgent: false,
		variant: HourglassStyle.sand,
		size: 18,
		label: "Add or skip by 3:40 pm tomorrow, or it'll be discarded",
	},
	argTypes: {
		fraction: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
		variant: {
			control: "inline-radio",
			options: Object.values(HourglassStyle),
		},
		size: { control: { type: "range", min: 12, max: 64, step: 1 } },
	},
};

export default meta;
type Story = StoryObj<typeof Hourglass>;

/** Interactive: drag the fraction, switch styles, toggle urgency. */
export const Playground: Story = {};

/** Static: every style at full, half, urgent and empty. */
export const AllStyles: Story = {
	render: () => (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "auto repeat(4, 80px)",
				gap: 16,
				alignItems: "center",
				color: "var(--ctd-ink)",
			}}
		>
			<span />
			{["Full", "Half", "Urgent", "Empty"].map((label) => (
				<strong key={label} style={{ fontSize: 12 }}>
					{label}
				</strong>
			))}
			{Object.values(HourglassStyle).map((variant) => (
				<div key={variant} style={{ display: "contents" }}>
					<span style={{ fontSize: 12 }}>{variant}</span>
					{[1, 0.5, 0.15, 0].map((fraction) => (
						<Hourglass
							key={fraction}
							variant={variant}
							fraction={fraction}
							urgent={fraction > 0 && fraction < 0.25}
							size={24}
							label={`${Math.round(fraction * 100)}% of the review window left`}
						/>
					))}
				</div>
			))}
		</div>
	),
};

const DrainingDemo = (args: HourglassProps) => {
	const [start] = useState(() => Date.now());
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 100);
		return () => clearInterval(timer);
	}, []);
	const windowSeconds = 20;
	const elapsed = ((now.getTime() - start) / 1000) % windowSeconds;
	const expiresAt = new Date(
		now.getTime() + (windowSeconds - elapsed) * 1000,
	).toISOString();
	const left = countdown(expiresAt, now, windowSeconds);
	return (
		<div
			style={{
				display: "flex",
				gap: 24,
				alignItems: "center",
				color: "var(--ctd-ink)",
			}}
		>
			{Object.values(HourglassStyle).map((variant) => (
				<Hourglass
					key={variant}
					{...args}
					variant={variant}
					fraction={left.fraction}
					urgent={left.urgent}
					size={32}
				/>
			))}
			<span style={{ fontSize: 13 }}>
				{Math.ceil(windowSeconds - elapsed)} s left
			</span>
		</div>
	);
};

/** Interactive: a review window squeezed into 20 seconds, turning urgent at the end. */
export const Draining: Story = {
	render: (args) => <DrainingDemo {...args} />,
};
