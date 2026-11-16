import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { SearchField } from "./SearchField";
import { SegmentedControl } from "./SegmentedControl";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { TextInput } from "./TextInput";

const Plus = () => (
	<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
		<path
			d="M7 2v10M2 7h10"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
		/>
	</svg>
);

/**
 * Every regular control at --ctd-control-height (24px on desktop-sized
 * screens, 36px on touch), sharing one row.
 */
const Row = () => {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState("title");
	const [view, setView] = useState("grid");
	const [unread, setUnread] = useState(true);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					flexWrap: "wrap",
					padding: "12px 0",
				}}
			>
				<SearchField
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder="Search"
					aria-label="Search"
				/>
				<Select
					value={sort}
					onChange={setSort}
					aria-label="Sort by"
					options={[
						{ value: "title", label: "Title" },
						{ value: "author", label: "Author" },
					]}
				/>
				<SegmentedControl
					value={view}
					onChange={setView}
					aria-label="View"
					items={[
						{ value: "grid", label: "Grid" },
						{ value: "list", label: "List" },
					]}
				/>
				<div style={{ width: 160 }}>
					<TextInput aria-label="Title" placeholder="Title" />
				</div>
				<Button>Cancel</Button>
				<Button variant="primary">Save</Button>
				<Button variant="danger">Delete…</Button>
				<IconButton aria-label="Add Book…">
					<Plus />
				</IconButton>
				<Switch
					checked={unread}
					onCheckedChange={setUnread}
					label="Unread Only"
				/>
			</div>
			<div style={{ display: "flex", gap: 8 }}>
				<Button disabled>Disabled</Button>
				<Button variant="subtle">Subtle</Button>
			</div>
		</div>
	);
};

const meta: Meta = {
	title: "components/ui/Controls",
};

export default meta;

export const Alignment: StoryObj = {
	render: () => <Row />,
};
