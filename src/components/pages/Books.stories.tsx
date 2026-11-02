import type { Meta, StoryObj } from "@storybook/react";
import type { LibraryAuthor, LibraryBook } from "@/bindings";
import { BookPage } from "./EditBook";

const meta: Meta<typeof BookPage> = {
	component: BookPage,
};
export default meta;

type Story = StoryObj<typeof BookPage>;

const Bugliacci: LibraryAuthor = {
	id: "0000004JFG0DKZV4DGR66BKW9D",
	name: "Bugliacci",
	sortable_name: "Bugliacci",
	book_count: 1,
};
const Gregor_Samsa: LibraryAuthor = {
	id: "0000004JFGJFYH5BDPJSENX6C8",
	name: "Gregor Samsa",
	sortable_name: "Samsa, Gregor",
	book_count: 1,
};

const MOCK_BOOK: LibraryBook = {
	id: "0000004JFGPMWM6WMEEFXRKXK8",
	uuid: "01901f97-c2c5-7ce8-9546-36455c321691",
	author_list: [Bugliacci],
	tag_list: ["Classic", "Satire"],
	description: "",
	file_list: [
		{
			Local: {
				path: "/tmp/this/path/does/not/exist",
				mime_type: "EPUB",
			},
		},
	],
	cover_image: null,
	title: "The Day I Bug'd",
	sortable_title: "Day I Bug'd, The",
	is_read: false,
	series: "The Bug Chronicles",
	series_index: 1.5,
	language_list: ["eng"],
	identifier_list: [
		{
			id: 123,
			label: "ISBN",
			value: "987654321",
		},
	],
};

export const Primary: Story = {
	args: {
		book: MOCK_BOOK,
		allAuthorList: [Bugliacci, Gregor_Samsa],
		allTagList: ["Classic", "Satire", "Metafiction"],
		onCreateAuthor: () => Promise.resolve(undefined),
		onDeleteIdentifier: () => Promise.resolve(),
		onReloadBooks: () => Promise.resolve(),
		onUpsertIdentifier: () => Promise.resolve(),
		onSave: (update) =>
			new Promise(() => window.alert(`Saved: ${JSON.stringify(update)}`)),
	},
};
