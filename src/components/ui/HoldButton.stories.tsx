import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { HoldButton } from "./HoldButton";

const meta: Meta<typeof HoldButton> = {
	component: HoldButton,
	args: {
		label: "Cancel All",
		hint: "Hold to cancel all uploads",
		onConfirm: fn(),
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

/**
 * Interactive: hold (or hold Space) to confirm, shown in the Actions panel;
 * a click shakes it and explains.
 */
export const Holding: Story = {};

/** Interactive: for actions that replace something rather than destroy it. */
export const Neutral: Story = {
	args: {
		label: "Rotate",
		hint: "Hold to replace this password",
		tone: "neutral",
	},
};

/** Interactive: full width, as the phone's "Cancel All Uploads" row. */
export const FullWidth: Story = {
	args: { label: "Cancel All Uploads" },
	render: (args) => (
		<div style={{ width: 360, display: "grid" }}>
			<HoldButton {...args} />
		</div>
	),
};
