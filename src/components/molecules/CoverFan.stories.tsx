import type { Meta, StoryObj } from "@storybook/react";
import { CoverFan, CoverFanStyle } from "./CoverFan";

const meta: Meta<typeof CoverFan> = {
	component: CoverFan,
	args: { variant: CoverFanStyle.paintings, size: 128 },
	argTypes: {
		variant: { control: "inline-radio", options: Object.values(CoverFanStyle) },
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

/** Interactive: switch styles and resize. */
export const Playground: Story = {};

/** Static: the three styles in ranked order. */
export const Styles: Story = {
	render: () => (
		<div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
			{Object.values(CoverFanStyle).map((variant) => (
				<figure
					key={variant}
					style={{
						margin: 0,
						display: "grid",
						gap: 16,
						justifyItems: "center",
						color: "white",
					}}
				>
					<CoverFan variant={variant} size={96} />
					<figcaption style={{ fontSize: 13 }}>{variant}</figcaption>
				</figure>
			))}
		</div>
	),
};
