import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "@/components/ui";
import { DropHalo } from "./DropHalo";

const meta: Meta<typeof DropHalo> = {
	component: DropHalo,
	args: { inset: 10, radius: 18 },
	render: (args) => (
		<div
			style={{
				position: "relative",
				height: 320,
				borderRadius: 12,
				background: "oklch(30% 0.01 270)",
			}}
		>
			<DropHalo {...args} />
		</div>
	),
};

export default meta;
type Story = StoryObj<typeof DropHalo>;

/** Static: round a window-sized area. */
export const Window: Story = {};

/** Static: wrapped just outside a sheet's edge. */
export const AroundASheet: Story = {
	render: () => (
		<div style={{ padding: 40, background: "oklch(30% 0.01 270)" }}>
			<div
				style={{
					position: "relative",
					width: 360,
					height: 240,
					margin: "0 auto",
					borderRadius: 12,
					background: "var(--ctd-surface)",
				}}
			>
				<DropHalo inset={-6} radius={16} />
			</div>
		</div>
	),
};

const Toggle = () => {
	const [on, setOn] = useState(true);
	return (
		<div style={{ display: "grid", gap: 12 }}>
			<Button onClick={() => setOn((value) => !value)}>
				{on ? "Leave" : "Drag Over"}
			</Button>
			<div
				style={{
					position: "relative",
					height: 240,
					borderRadius: 12,
					background: "oklch(30% 0.01 270)",
				}}
			>
				{on && <DropHalo />}
			</div>
		</div>
	);
};

/** Interactive: the halo arriving and leaving as a drag comes and goes. */
export const Toggling: Story = { render: () => <Toggle /> };
