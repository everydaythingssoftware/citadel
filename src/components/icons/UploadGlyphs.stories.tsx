import type { Meta, StoryObj } from "@storybook/react";
import {
	AlertGlyph,
	BooksGlyph,
	CalendarGlyph,
	ChevronLeftGlyph,
	ChevronRightGlyph,
	DraftsGlyph,
	PlusGlyph,
	TrayGlyph,
	UploadGlyph,
	XmarkGlyph,
} from "./UploadGlyphs";

/** The calendar shows a day; the 7th stands in for any. */
const CalendarSeventh = () => <CalendarGlyph day={7} />;

const GLYPHS = {
	AlertGlyph,
	BooksGlyph,
	CalendarGlyph: CalendarSeventh,
	ChevronLeftGlyph,
	ChevronRightGlyph,
	DraftsGlyph,
	PlusGlyph,
	TrayGlyph,
	UploadGlyph,
	XmarkGlyph,
};

const meta: Meta = {
	title: "icons/UploadGlyphs",
	args: { size: 24 },
	argTypes: { size: { control: { type: "range", min: 12, max: 64, step: 2 } } },
};

export default meta;
type Story = StoryObj<{ size: number }>;

/** Static and interactive: every glyph; drag the size. */
export const All: Story = {
	render: ({ size }) => (
		<div
			style={{
				display: "flex",
				gap: 24,
				flexWrap: "wrap",
				color: "var(--ctd-ink)",
				fontSize: size,
			}}
		>
			{Object.entries(GLYPHS).map(([name, Glyph]) => (
				<figure
					key={name}
					style={{ margin: 0, display: "grid", gap: 6, justifyItems: "center" }}
				>
					<Glyph />
					<figcaption style={{ fontSize: 11 }}>{name}</figcaption>
				</figure>
			))}
		</div>
	),
};
