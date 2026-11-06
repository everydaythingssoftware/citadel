import type { Meta, StoryObj } from "@storybook/react";
import { EditGlyph } from "@/components/icons/EditGlyph";
import { TrashGlyph } from "@/components/icons/TrashGlyph";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

const meta: Meta = {
	title: "Components/UI/Buttons",
};

export default meta;
type Story = StoryObj;

const row = { display: "flex", gap: 12, alignItems: "center" } as const;
const label = {
	width: 88,
	fontSize: 12,
	color: "var(--ctd-ink-soft)",
} as const;

const Plus = () => (
	<svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
		<path
			d="M7 2v10M2 7h10"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	</svg>
);

/**
 * The whole set. Every button is the same height (28px, 36px on touch), with
 * the same padding and type; a role picks its look. Icon buttons are squares
 * of that height.
 */
export const Standard: Story = {
	render: () => (
		<div style={{ display: "grid", gap: 16, color: "var(--ctd-ink)" }}>
			<div style={row}>
				<span style={label}>Default</span>
				<Button>Show in Finder</Button>
				<Button>
					<Plus />
					Add Book…
				</Button>
				<Button disabled>Add</Button>
			</div>
			<div style={row}>
				<span style={label}>Primary</span>
				<Button variant="primary">Save</Button>
				<Button variant="primary">
					<EditGlyph />
					Edit
				</Button>
				<Button variant="primary" disabled>
					Save
				</Button>
			</div>
			<div style={row}>
				<span style={label}>Subtle</span>
				<Button variant="subtle">Revert</Button>
				<Button variant="subtle">Cancel</Button>
			</div>
			<div style={row}>
				<span style={label}>Danger</span>
				<Button variant="danger">Delete Book</Button>
			</div>
			<div style={row}>
				<span style={label}>Icon</span>
				<IconButton aria-label="Edit">
					<EditGlyph />
				</IconButton>
				<IconButton aria-label="Delete">
					<TrashGlyph />
				</IconButton>
				<Button>Beside a button</Button>
			</div>
		</div>
	),
};
