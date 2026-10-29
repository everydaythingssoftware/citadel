import type { Meta, StoryObj } from "@storybook/react";
import { SettingsButton } from "./SettingsButton";

const meta = {
	component: SettingsButton,
	args: { updateVersion: null, onClick: () => {} },
	decorators: [
		// The sidebar footer the gear lives in.
		(Story) => (
			<div
				style={{
					alignSelf: "end",
					width: 220,
					padding: "12px 16px",
					backgroundColor: "var(--ctd-nav-bg)",
				}}
			>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof SettingsButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoUpdate: Story = {};

export const UpdateAvailable: Story = {
	args: { updateVersion: "0.7.2" },
};
