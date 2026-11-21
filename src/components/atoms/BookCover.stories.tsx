import type { Meta, StoryObj } from "@storybook/react";
import type { CoverColors, LibraryBook } from "@/bindings";
import { BookCover } from "./BookCover";

/**
 * A transparent image the size of a thumbnail: a stand-in for a cover that
 * has not arrived yet, so what shows is the placeholder behind it.
 */
const STILL_LOADING = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"/>',
)}`;

const book = (id: string, title: string): LibraryBook => ({
	id,
	uuid: null,
	title,
	sortable_title: null,
	author_list: [],
	tag_list: [],
	description: null,
	file_list: [],
	cover_image: { kind: "Remote", url: STILL_LOADING, local_path: null },
	is_read: false,
	series: null,
	series_index: null,
	language_list: [],
	added_at: "2026-11-10T10:00:00Z",
	identifier_list: [],
});

/** What citadel-core's cover_colors gives each of these covers. */
const COVERS: { title: string; colors: CoverColors | null }[] = [
	{
		// Solid rgb(40, 80, 120), the hash pinned in the Rust and TS tests.
		title: "ThumbHash: solid blue",
		colors: {
			palette: {
				dominant: {
					l: 0.42183394548483344,
					a: -0.027271714012120363,
					b: -0.07619850732504196,
					share: 1,
				},
				secondary: null,
			},
			thumbhash: "FLYBBQCGhnh4h4iHd3eH9weH+Ed4",
		},
	},
	{
		// Red over an amber band.
		title: "ThumbHash: red and amber",
		colors: {
			palette: {
				dominant: {
					l: 0.37040097804771877,
					a: 0.1052925303324819,
					b: 0.050180778893390156,
					share: 0.6458333333333334,
				},
				secondary: {
					l: 0.6006462899528494,
					a: 0.04368352888135707,
					b: 0.06685143353256263,
					share: 0.3125,
				},
			},
			thumbhash: "U4kKDQSIh4CIuIiIiIaYiIeAi/hI",
		},
	},
	{
		// A green cover with no hash: the flat main colour.
		title: "Flat colour",
		colors: {
			palette: {
				dominant: {
					l: 0.37255154691263526,
					a: -0.0554444354341126,
					b: 0.009386526714990726,
					share: 0.6458333333333334,
				},
				secondary: null,
			},
			thumbhash: "",
		},
	},
	{ title: "No colours", colors: null },
];

const Covers = () => (
	<div style={{ display: "flex", gap: 24, alignItems: "flex-end" }}>
		{COVERS.map(({ title, colors }, index) => (
			<figure key={title} style={{ width: 150, margin: 0 }}>
				<BookCover
					book={book(String(index + 1), title)}
					fluid
					thumb={{
						book_id: String(index + 1),
						url: STILL_LOADING,
						width: 300,
						height: 450,
						cover_colors: colors,
					}}
				/>
				<figcaption style={{ fontSize: 12, marginTop: 8 }}>{title}</figcaption>
			</figure>
		))}
	</div>
);

const meta: Meta<typeof Covers> = {
	title: "Components/Atoms/BookCover",
	component: Covers,
};
export default meta;

type Story = StoryObj<typeof Covers>;

/**
 * Grid covers mid-load: the decoded ThumbHash, then the flat main colour
 * when there is no hash, then today's look when there are no colours.
 */
export const LoadingPlaceholders: Story = {};
