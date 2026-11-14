import type { Meta, StoryObj } from "@storybook/react";
import { ServerUpdatedBanner } from "./ServerUpdatedBanner";

const meta = {
	component: ServerUpdatedBanner,
	parameters: { layout: "fullscreen" },
	args: { onReload: () => {}, onDismiss: () => {} },
	decorators: [
		(Story) => (
			<div style={{ height: 160, background: "var(--ctd-content-bg)" }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof ServerUpdatedBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
