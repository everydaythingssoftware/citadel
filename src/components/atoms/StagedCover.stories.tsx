import type { Meta, StoryObj } from "@storybook/react";
import painting from "../../assets/2.jpg";
import { StagedCover } from "./StagedCover";

const meta: Meta<typeof StagedCover> = {
	component: StagedCover,
	args: { seed: "Walden" },
	decorators: [
		(Story) => (
			<div style={{ display: "flex", gap: 24 }}>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof StagedCover>;

const size = { width: 120, aspectRatio: "2 / 3", borderRadius: 4 };

/** Static: a cover image with the spine, and a motif cover for a book without one. */
export const WithAndWithoutImage: Story = {
	render: (args) => (
		<>
			<div style={size}>
				<StagedCover {...args} coverUrl={painting} />
			</div>
			<div style={size}>
				<StagedCover {...args} coverUrl={null} />
			</div>
		</>
	),
};
