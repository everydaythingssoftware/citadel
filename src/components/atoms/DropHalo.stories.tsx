import type { Meta, StoryObj } from "@storybook/react";
import { DropHalo } from "./DropHalo";

const meta: Meta<typeof DropHalo> = {
	component: DropHalo,
	render: () => (
		<div
			style={{
				position: "relative",
				height: 320,
				borderRadius: 12,
				background: "oklch(30% 0.01 270)",
			}}
		>
			<DropHalo />
		</div>
	),
};

export default meta;
type Story = StoryObj<typeof DropHalo>;

/** Static: round a window-sized area. */
export const Window: Story = {};
