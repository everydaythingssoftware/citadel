import type { Meta, StoryObj } from "@storybook/react";
import type { LibraryBook } from "@/bindings";
import { BookCover } from "./BookCover";

const book = (title: string, author: string): LibraryBook => ({
	id: title,
	uuid: null,
	title,
	author_list: [
		{ id: author, name: author, sortable_name: author, book_count: 1 },
	],
	tag_list: [],
	sortable_title: null,
	file_list: [],
	cover_image: null,
	identifier_list: [],
	description: null,
	is_read: false,
	series: null,
	series_index: null,
	language_list: [],
});

const BOOKS = [
	book("Walden", "Henry David Thoreau"),
	book("Middlemarch", "George Eliot"),
	book("Kim", "Rudyard Kipling"),
	book("Persuasion", "Jane Austen"),
	book("The Jungle Book", "Rudyard Kipling"),
	book("Heart of Darkness", "Joseph Conrad"),
];

const meta: Meta<typeof BookCover> = {
	component: BookCover,
	args: { book: BOOKS[0], placeholder: "paintings" },
	argTypes: {
		placeholder: {
			control: "inline-radio",
			options: ["paintings", "patterns"],
		},
		book: { table: { disable: true } },
	},
};

export default meta;
type Story = StoryObj<typeof BookCover>;

/** Interactive: switch the placeholder style for a book without a cover. */
export const Placeholder: Story = {};

/** Static: the two placeholder styles side by side, for choosing between them. */
export const PlaceholderStyles: Story = {
	render: () => (
		<div style={{ display: "grid", gap: 32 }}>
			{(["paintings", "patterns"] as const).map((placeholder) => (
				<section key={placeholder} style={{ display: "grid", gap: 12 }}>
					<h3 style={{ margin: 0, fontSize: 13, color: "var(--ctd-ink)" }}>
						{placeholder}
					</h3>
					<div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
						{BOOKS.map((item) => (
							<BookCover
								key={item.title}
								book={item}
								placeholder={placeholder}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	),
};
