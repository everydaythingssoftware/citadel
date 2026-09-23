import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";
import {
	ContextMenu,
	type ContextMenuItem,
	type ContextMenuState,
} from "./ContextMenu";

const MENU_ITEMS: ContextMenuItem[] = [
	{
		id: "rename",
		label: "Rename",
		onSelect: () => console.log("Rename"),
	},
	{
		id: "reveal",
		label: "Reveal in Finder",
		onSelect: () => console.log("Reveal in Finder"),
	},
];

const INITIAL_MENU: ContextMenuState = {
	x: 260,
	y: 200,
	items: MENU_ITEMS,
};

/** Mock list row standing in for a LibraryListCard row; right-click re-opens the menu at the pointer. */
const MockListRow = () => {
	const rowRef = useRef<HTMLButtonElement>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(INITIAL_MENU);

	return (
		<div
			style={{
				width: 340,
				border: "1px solid var(--ctd-border)",
				borderRadius: "0.5rem",
				backgroundColor: "var(--ctd-surface)",
			}}
		>
			<button
				ref={rowRef}
				type="button"
				style={{
					display: "flex",
					alignItems: "center",
					gap: "0.625rem",
					width: "100%",
					minHeight: "2.375rem",
					padding: "0.4375rem 0.875rem",
					border: "none",
					background: "none",
					font: "inherit",
					color: "var(--ctd-ink)",
					textAlign: "left",
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({
						x: event.clientX,
						y: event.clientY,
						items: MENU_ITEMS,
					});
				}}
			>
				Fiction — /Users/phil/Calibre Libraries/Fiction
			</button>
			<ContextMenu
				menu={menu}
				returnFocusRef={rowRef}
				onClose={() => setMenu(null)}
			/>
		</div>
	);
};

const meta: Meta<typeof ContextMenu> = {
	component: ContextMenu,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
	render: () => <MockListRow />,
};
