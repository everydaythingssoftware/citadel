import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef } from "react";
import { useContextMenu } from "@/lib/hooks/use-context-menu";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";

const log = (label: string) => () => console.log(label);

const BOOK_ITEMS: ContextMenuEntry[] = [
	{
		id: "details",
		label: "Show Details",
		shortcut: "⌘I",
		onSelect: log("Show Details"),
	},
	{ id: "open", label: "Open", shortcut: "⌘O", onSelect: log("Open") },
	{
		id: "quick-look",
		label: "Quick Look",
		shortcut: "Space",
		onSelect: log("Quick Look"),
	},
	{ type: "separator", id: "s1" },
	{ id: "edit", label: "Edit…", shortcut: "⌘E", onSelect: log("Edit…") },
	{
		id: "finished",
		label: "Mark as Finished",
		onSelect: log("Mark as Finished"),
	},
	{
		id: "show",
		label: "Show in Finder",
		shortcut: "⇧⌘R",
		onSelect: log("Show in Finder"),
	},
	{ id: "copy", label: "Copy Title", onSelect: log("Copy Title") },
	{
		id: "convert",
		label: "Convert to EPUB",
		disabled: true,
		onSelect: log("Convert"),
	},
	{ type: "separator", id: "s2" },
	{
		id: "delete",
		label: "Delete…",
		shortcut: "⌘⌫",
		destructive: true,
		onSelect: log("Delete…"),
	},
];

const SORT_ITEMS: ContextMenuEntry[] = [
	{
		id: "name-az",
		label: "Name A–Z",
		checked: true,
		onSelect: log("Name A–Z"),
	},
	{
		id: "name-za",
		label: "Name Z–A",
		checked: false,
		onSelect: log("Name Z–A"),
	},
	{ type: "separator", id: "s" },
	{
		id: "author-az",
		label: "Author A–Z",
		checked: false,
		onSelect: log("Author A–Z"),
	},
	{
		id: "author-za",
		label: "Author Z–A",
		checked: false,
		onSelect: log("Author Z–A"),
	},
];

interface DemoProps {
	items: ContextMenuEntry[];
	label: string;
}

/** A row standing in for a book card; right-click (or Shift-F10) opens the menu. */
const Demo = ({ items, label }: DemoProps) => {
	const rowRef = useRef<HTMLButtonElement>(null);
	const menu = useContextMenu();
	const { openAt } = menu;

	useEffect(() => {
		const rect = rowRef.current?.getBoundingClientRect();
		if (!rect) return;
		openAt(
			{
				clientX: rect.left + 40,
				clientY: rect.bottom + 6,
				preventDefault: () => {},
			},
			items,
			label,
		);
	}, [items, label, openAt]);

	return (
		<div
			style={{
				height: 420,
				padding: 24,
				background:
					"linear-gradient(135deg, oklch(70% 0.12 40), oklch(55% 0.1 250))",
				borderRadius: 10,
			}}
		>
			<button
				ref={rowRef}
				type="button"
				style={{
					width: 320,
					padding: "8px 12px",
					border: "1px solid var(--ctd-border)",
					borderRadius: 8,
					background: "var(--ctd-surface)",
					font: "inherit",
					color: "var(--ctd-ink)",
					textAlign: "left",
				}}
				onContextMenu={(event) => menu.openAt(event, items, label)}
				onKeyDown={(event) => {
					if (
						event.key !== "ContextMenu" &&
						!(event.key === "F10" && event.shiftKey)
					)
						return;
					const rect = event.currentTarget.getBoundingClientRect();
					menu.openAt(
						{
							clientX: rect.left + 12,
							clientY: rect.bottom + 4,
							preventDefault: () => event.preventDefault(),
						},
						items,
						label,
					);
				}}
			>
				Middlemarch — George Eliot
			</button>
			<ContextMenu
				menu={menu.menu}
				returnFocusRef={rowRef}
				onClose={menu.close}
			/>
		</div>
	);
};

const meta: Meta<typeof ContextMenu> = {
	component: ContextMenu,
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Switch the toolbar's Platform between macos and windows to compare. */
export const BookActions: Story = {
	render: () => <Demo items={BOOK_ITEMS} label="Book actions" />,
};

export const Checkmarks: Story = {
	render: () => <Demo items={SORT_ITEMS} label="Sort by" />,
};
