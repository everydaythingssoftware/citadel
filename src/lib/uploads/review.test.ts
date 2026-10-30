import { describe, expect, it } from "vitest";
import { canAddForm, formForBook, isValidDate, reviewedFromForm } from "./review";

describe("review form", () => {
	it("starts from what the file says", () => {
		expect(
			formForBook({
				format: "epub",
				title: "Walden",
				authorNames: ["Henry David Thoreau"],
				identifier: null,
				publisher: "Ticknor and Fields",
				language: "en",
				tags: ["Nature"],
				publicationDate: "1854-08-09",
				coverUrl: null,
			}),
		).toEqual({
			title: "Walden",
			authors: ["Henry David Thoreau"],
			publisher: "Ticknor and Fields",
			language: "en",
			tags: ["Nature"],
			publicationDate: "1854-08-09",
			identifier: "",
		});
		expect(formForBook(undefined).title).toBe("");
	});

	it("commits trimmed values and leaves blanks out", () => {
		expect(
			reviewedFromForm({
				title: "  Walden ",
				authors: [" Thoreau ", " "],
				publisher: " ",
				language: "en",
				tags: ["", "Nature"],
				publicationDate: "",
				identifier: " 9780000000002 ",
			}),
		).toEqual({
			title: "Walden",
			authorNames: ["Thoreau"],
			publisher: null,
			language: "en",
			tags: ["Nature"],
			publicationDate: null,
			identifier: "9780000000002",
		});
	});

	it("needs a title and a real date, if any", () => {
		const form = formForBook(undefined);
		expect(canAddForm(form)).toBe(false);
		expect(canAddForm({ ...form, title: "A" })).toBe(true);
		expect(canAddForm({ ...form, title: "A", publicationDate: "1854-13-45" })).toBe(false);
		expect(isValidDate("1854-08-09")).toBe(true);
		expect(isValidDate("Aug 1854")).toBe(false);
	});
});
