import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "./Button";
import { SearchField } from "./SearchField";
import { SegmentedControl } from "./SegmentedControl";
import { Select } from "./Select";
import { TextInput } from "./TextInput";

/**
 * The two focus rings the owner is choosing between: monochrome ink (the
 * default) and the link blue (`data-focus-ring="accent"` on <html>). Each
 * column draws its rings as they look when focused, then offers real
 * controls to Tab through.
 */
const Column = ({ ring }: { ring: "monochrome" | "accent" }) => {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState("title");
	const [view, setView] = useState("grid");
	return (
		<section
			data-focus-ring={ring}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 14,
				padding: 20,
				width: 300,
				border: "1px solid var(--ctd-border)",
				borderRadius: 10,
				background: "var(--ctd-surface)",
			}}
		>
			<h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
				{ring === "monochrome" ? "Monochrome (default)" : "Accent"}
			</h3>
			<div style={{ display: "flex", gap: 8 }}>
				<Button style={{ boxShadow: "var(--ctd-focus-shadow)" }}>Cancel</Button>
				<Button
					variant="primary"
					style={{
						boxShadow: "var(--ctd-control-shadow), var(--ctd-focus-shadow)",
					}}
				>
					Save
				</Button>
			</div>
			<input
				readOnly
				value="Middlemarch"
				aria-label="Focused field sample"
				style={{
					height: "var(--ctd-control-height)",
					padding: "0 8px",
					font: "inherit",
					fontSize: 13,
					borderRadius: "var(--ctd-radius-control)",
					border: "1px solid var(--ctd-focus-border)",
					boxShadow: "var(--ctd-focus-shadow)",
					background: "var(--ctd-control-bg)",
					color: "var(--ctd-control-text)",
					outline: "none",
				}}
			/>
			<hr
				style={{
					width: "100%",
					border: "none",
					borderTop: "1px solid var(--ctd-border)",
				}}
			/>
			<SearchField
				value={query}
				onChange={(event) => setQuery(event.currentTarget.value)}
				placeholder="Search"
				aria-label="Search"
			/>
			<TextInput label="Title" defaultValue="" placeholder="Title" />
			<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
				<Button>Add Book…</Button>
			</div>
		</section>
	);
};

const meta: Meta = {
	title: "components/ui/Focus Ring",
};

export default meta;

export const SideBySide: StoryObj = {
	render: () => (
		<div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
			<Column ring="monochrome" />
			<Column ring="accent" />
		</div>
	),
};
