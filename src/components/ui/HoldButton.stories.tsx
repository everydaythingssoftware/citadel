import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { HoldButton } from "./HoldButton";

const meta: Meta<typeof HoldButton> = {
	component: HoldButton,
	args: {
		label: "Cancel All",
		hint: "Hold to cancel all uploads",
		onConfirm: () => console.log("confirmed"),
	},
	decorators: [
		(Story) => (
			<div style={{ padding: "48px 24px", display: "flex", gap: 16 }}>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof HoldButton>;

/** Static: at rest, and disabled. */
export const AtRest: Story = {
	render: (args) => (
		<>
			<HoldButton {...args} />
			<HoldButton {...args} disabled />
		</>
	),
};

const Counter = ({
	full = false,
	...args
}: React.ComponentProps<typeof HoldButton> & { full?: boolean }) => {
	const [count, setCount] = useState(0);
	return (
		<div
			style={{
				display: "grid",
				gap: 12,
				alignContent: "start",
				justifyItems: full ? "stretch" : "start",
				color: "var(--ctd-ink)",
			}}
		>
			<HoldButton {...args} onConfirm={() => setCount((value) => value + 1)} />
			<span style={{ fontSize: 13 }}>
				Confirmed {count} {count === 1 ? "time" : "times"}. Click to see the
				hint; hold (or hold Space) to confirm.
			</span>
		</div>
	);
};

/** Interactive: hold to confirm; a click shakes and explains. */
export const Holding: Story = { render: (args) => <Counter {...args} /> };

/** Interactive: full width, as the phone's "Cancel All Uploads" row. */
export const FullWidth: Story = {
	args: { label: "Cancel All Uploads" },
	render: (args) => (
		<div style={{ width: 360 }}>
			<Counter {...args} full />
		</div>
	),
};
