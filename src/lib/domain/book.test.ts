import { describe, expect, it } from "vitest";

import type { BookUpdate, LibraryAuthor, LibraryBook } from "@/bindings";
import { projectBookUpdate } from "./book";

const ann: LibraryAuthor = {
	id: "1",
	name: "Ann Author",
	sortable_name: "Author, Ann",
	book_count: 2,
};
const bob: LibraryAuthor = {
	id: "2",
	name: "Bob Writer",
	sortable_name: "Writer, Bob",
	book_count: 1,
};

const book: LibraryBook = {
	id: "7",
	uuid: null,
	title: "Dune",
	author_list: [ann],
	tag_list: ["sf"],
	sortable_title: "Dune",
	file_list: [],
	cover_image: null,
	identifier_list: [],
	description: "Spice",
	is_read: false,
	series: "Saga",
	series_index: 1,
	language_list: ["eng"],
};

const noChanges: BookUpdate = {
	author_id_list: null,
	tag_list: null,
	title: null,
	timestamp: null,
	publication_date: null,
	is_read: null,
	description: null,
	series: null,
	series_index: null,
	language_list: null,
};

describe("projectBookUpdate", () => {
	it("leaves the book untouched when nothing is set", () => {
		expect(projectBookUpdate(book, noChanges, [ann, bob])).toEqual(book);
	});

	it("applies scalar and list fields", () => {
		const projected = projectBookUpdate(
			book,
			{
				...noChanges,
				title: "Dune Messiah",
				is_read: true,
				description: "More spice",
				tag_list: ["classic"],
				language_list: ["fra"],
				series_index: 2,
			},
			[ann, bob],
		);
		expect(projected).toMatchObject({
			title: "Dune Messiah",
			is_read: true,
			description: "More spice",
			tag_list: ["classic"],
			language_list: ["fra"],
			series_index: 2,
		});
		expect(book.title).toBe("Dune");
	});

	it("resolves author ids against the known authors, in order", () => {
		const projected = projectBookUpdate(
			book,
			{ ...noChanges, author_id_list: ["2", "1"] },
			[ann, bob],
		);
		expect(projected.author_list.map((author) => author.id)).toEqual([
			"2",
			"1",
		]);
	});

	it("keeps the current authors when an id is unknown", () => {
		const projected = projectBookUpdate(
			book,
			{ ...noChanges, author_id_list: ["2", "99"] },
			[ann, bob],
		);
		expect(projected.author_list).toEqual([ann]);
	});

	it("trims series names and unlinks on blank, like the backend", () => {
		expect(
			projectBookUpdate(book, { ...noChanges, series: "  Epic  " }, []).series,
		).toBe("Epic");
		const unlinked = projectBookUpdate(
			book,
			{ ...noChanges, series: "   ", series_index: 3 },
			[],
		);
		expect(unlinked.series).toBeNull();
		expect(unlinked.series_index).toBeNull();
	});
});
