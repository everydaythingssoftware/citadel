import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import { bookCoverProps } from "@/lib/covers/book-cover";
import { BookCover } from "./BookCover";

const book = {
	title: "A title",
	author_list: [],
	is_read: true,
	cover_image: null,
	id: "1",
	uuid: null,
	tag_list: [],
	sortable_title: null,
	file_list: [],
	identifier_list: [],
	description: null,
	series: null,
	series_index: null,
	language_list: [],
	added_at: "2026-01-01T00:00:00Z",
} satisfies LibraryBook;

it("uses the thumbnail and reserves its proportions", () => {
	const html = renderToStaticMarkup(
		createElement(BookCover, {
			...bookCoverProps(book, {
				book_id: "1",
				url: "/thumb.jpg",
				width: 100,
				height: 150,
				cover_colors: null,
			}),
		}),
	);
	expect(html).toContain('src="/thumb.jpg"');
	expect(html).toContain('width="100"');
	expect(html).toContain('height="150"');
});

it("paints the cover colours placeholder behind the image", () => {
	const html = renderToStaticMarkup(
		createElement(BookCover, {
			...bookCoverProps(book, {
				book_id: "1",
				url: "/thumb.jpg",
				width: 100,
				height: 150,
				cover_colors: {
					palette: {
						dominant: { l: 0.42, a: -0.027, b: -0.076, share: 1 },
						secondary: null,
					},
					thumbhash: "",
				},
			}),
		}),
	);
	expect(html).toContain("background-color:oklab(42.0% -0.027 -0.076)");
	expect(html).toContain('data-placeholder=""');
});

it("uses the titled fallback for a missing metadata image", () => {
	const html = renderToStaticMarkup(
		createElement(BookCover, {
			title: "Book title",
			maxHeight: 84,
		}),
	);
	expect(html).toContain("Book title");
});

it("keeps upload/review fallback artwork free of editable text", () => {
	const html = renderToStaticMarkup(
		createElement(BookCover, {
			title: "Provisional title",
			provisional: true,
		}),
	);
	expect(html).not.toContain("Provisional title");
});

it.each([
	undefined,
	"   ",
])("uses geometric artwork without a usable title (%j)", (title) => {
	const html = renderToStaticMarkup(createElement(BookCover, { title }));
	expect(html).not.toContain("<img");
});
