import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { useFileDrag } from "@/lib/hooks/use-file-drag";
import { CoverFanStyle } from "./CoverFan";
import { DropOverlay, type DropOverlayProps } from "./DropOverlay";

const meta: Meta<typeof DropOverlay> = {
	component: DropOverlay,
	args: { visible: true, fan: CoverFanStyle.paintings, contained: true },
	argTypes: {
		fan: { control: "inline-radio", options: Object.values(CoverFanStyle) },
	},
	render: (args) => (
		<div
			style={{
				position: "relative",
				minHeight: 520,
				overflow: "hidden",
				borderRadius: 8,
			}}
		>
			<Library />
			<DropOverlay {...args} />
		</div>
	),
};

export default meta;
type Story = StoryObj<typeof DropOverlay>;

const COLOURS = [
	"oklch(38% 0.06 250)",
	"oklch(42% 0.08 30)",
	"oklch(35% 0.05 160)",
	"oklch(45% 0.07 70)",
];

const TILES = Array.from({ length: 18 }, (_, index) => index);

/** A stand-in library behind the overlay. */
const Library = () => (
	<div
		style={{
			display: "grid",
			gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
			gap: 20,
			padding: 24,
		}}
	>
		{TILES.map((tile) => (
			<div
				key={tile}
				style={{
					aspectRatio: "2 / 3",
					borderRadius: 3,
					background: COLOURS[tile % COLOURS.length],
				}}
			/>
		))}
	</div>
);

/** Static: the overlay as it shows during a drag. */
export const Showing: Story = {};

const DragHere = (args: DropOverlayProps) => {
	const [dropped, setDropped] = useState<string[]>([]);
	const dragging = useFileDrag({
		enabled: true,
		onDrop: (files) => setDropped(files.map((file) => file.name)),
	});
	return (
		<div
			style={{
				position: "relative",
				minHeight: 520,
				overflow: "hidden",
				borderRadius: 8,
			}}
		>
			<p
				style={{
					position: "relative",
					zIndex: 2,
					padding: "0 24px",
					color: "var(--ctd-ink)",
				}}
			>
				Drag files from your computer anywhere onto this page.
				{dropped.length > 0 && ` Dropped: ${dropped.join(", ")}`}
			</p>
			<Library />
			<DropOverlay {...args} visible={dragging} />
		</div>
	);
};

/** Interactive: drag real files over the page to see it appear and fade. */
export const DragFiles: Story = { render: (args) => <DragHere {...args} /> };
