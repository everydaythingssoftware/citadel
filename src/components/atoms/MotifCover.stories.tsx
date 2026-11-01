import type { Meta, StoryObj } from "@storybook/react";
import { MotifCover } from "./MotifCover";

const meta: Meta<typeof MotifCover> = {
	component: MotifCover,
	args: { seed: "Walden" },
	render: (args) => (
		<div style={{ width: 160 }}>
			<MotifCover {...args} />
		</div>
	),
};

export default meta;
type Story = StoryObj<typeof MotifCover>;

/** Interactive: type a title to see its cover. */
export const Playground: Story = {};

const TITLES = [
	"Walden",
	"Kim",
	"Emma",
	"Dracula",
	"Persuasion",
	"Little Women",
	"Ulysses",
	"Beowulf",
	"The Odyssey",
	"Frankenstein",
	"Middlemarch",
	"Moby-Dick",
	"The Jungle Book",
	"Anne of Green Gables",
	"A Tale of Two Cities",
	"Great Expectations",
	"Jane Eyre",
	"Wuthering Heights",
	"Silas Marner",
	"The Secret Garden",
	"Treasure Island",
	"Heart of Darkness",
	"Bleak House",
	"Vanity Fair",
];

/** Static: a shelf of generated covers. */
export const Shelf: Story = {
	render: () => (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
				gap: 20,
			}}
		>
			{TITLES.map((title) => (
				<MotifCover key={title} seed={title} />
			))}
		</div>
	),
};
