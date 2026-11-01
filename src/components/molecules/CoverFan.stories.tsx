import type { Meta, StoryObj } from "@storybook/react";
import { CoverFan } from "./CoverFan";

const meta: Meta<typeof CoverFan> = {
	component: CoverFan,
	args: { size: 128 },
	argTypes: {
		size: { control: { type: "range", min: 48, max: 220, step: 4 } },
	},
	decorators: [
		(Story) => (
			<div
				style={{
					display: "grid",
					placeItems: "center",
					padding: 40,
					borderRadius: 14,
					background: "oklch(34% 0.006 270)",
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof CoverFan>;

/** Interactive: resize the fan. */
export const Playground: Story = {};

/** Static: the fan at the size the drop overlay uses, and smaller. */
export const Sizes: Story = {
	render: () => (
		<div style={{ display: "flex", gap: 40, alignItems: "end" }}>
			<CoverFan size={128} />
			<CoverFan size={72} />
		</div>
	),
};
