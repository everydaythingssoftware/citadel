import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Select, type SelectOption } from "./Select";

const SORT: SelectOption[] = [
	{ value: "nameAz", label: "Name (A–Z)" },
	{ value: "nameZa", label: "Name (Z–A)" },
	{ value: "authorAz", label: "Author (A–Z)" },
	{ value: "authorZa", label: "Author (Z–A)" },
];

const LANGUAGES: SelectOption[] = Array.from({ length: 40 }, (_, index) => ({
	value: `language-${index}`,
	label: `Language ${index + 1}`,
}));

interface FrameProps {
	options: SelectOption[];
	initial: string;
	/** Where the pop-up button sits in the window. */
	placement: "top" | "middle" | "bottom";
}

const Frame = ({ options, initial, placement }: FrameProps) => {
	const [value, setValue] = useState(initial);
	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				display: "flex",
				justifyContent: "center",
				alignItems:
					placement === "top"
						? "flex-start"
						: placement === "bottom"
							? "flex-end"
							: "center",
				padding: "57px 0",
			}}
		>
			<Select
				width={150}
				aria-label="Sort order"
				options={options}
				value={value}
				onChange={setValue}
			/>
		</div>
	);
};

const meta: Meta<typeof Frame> = {
	title: "UI/Select",
	component: Frame,
	parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Frame>;

/**
 * The scope bar's sort pop-up, near the top of the window with its last
 * item chosen: every item shows, with no scroll arrow.
 */
export const NearTop: Story = {
	args: { options: SORT, initial: "authorZa", placement: "top" },
};

export const NearBottom: Story = {
	args: { options: SORT, initial: "nameAz", placement: "bottom" },
};

/** A long list scrolls, with arrows, wherever it opens. */
export const LongList: Story = {
	args: { options: LANGUAGES, initial: "language-20", placement: "middle" },
};

export const LongListNearTop: Story = {
	args: { options: LANGUAGES, initial: "language-30", placement: "top" },
};
