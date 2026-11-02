import { describe, expect, it } from "vitest";
import {
	canAddForm,
	fieldProblem,
	formForBook,
	isValidDate,
	languageNameForFileCode,
	reviewedFromForm,
	tidyField,
} from "./review";

const book = {
	format: "epub",
	title: "Walden",
	authorNames: ["Henry David Thoreau"],
	identifier: "urn:isbn:0141439513",
	publisher: "Ticknor and Fields",
	language: "en",
	tags: ["Nature"],
	publicationDate: "1854-08-09",
	coverUrl: null,
};

describe("review form", () => {
	it("starts from what the file says, with names and hyphens people read", () => {
		expect(formForBook(book)).toEqual({
			title: "Walden",
			authors: ["Henry David Thoreau"],
			publisher: "Ticknor and Fields",
			language: "English",
			tags: ["Nature"],
			publicationDate: "1854-08-09",
			identifier: "0-14-143951-3",
		});
		expect(formForBook(undefined).title).toBe("");
	});

	it("leaves out identifiers that aren't ISBNs", () => {
		expect(
			formForBook({ ...book, identifier: "urn:uuid:1234" }).identifier,
		).toBe("");
	});

	it("names languages from file tags and Calibre codes", () => {
		expect(languageNameForFileCode("fr-CA")).toBe("French");
		expect(languageNameForFileCode("deu")).toBe("German");
		expect(languageNameForFileCode("")).toBe("");
	});

	it("commits trimmed values, language codes and compact ISBNs", () => {
		expect(
			reviewedFromForm({
				title: "  Walden ",
				authors: [" Thoreau ", " "],
				publisher: " ",
				language: "French",
				tags: ["", "Nature"],
				publicationDate: "",
				identifier: " 978-0-14-143951-8 ",
			}),
		).toEqual({
			title: "Walden",
			authorNames: ["Thoreau"],
			publisher: null,
			language: "fra",
			tags: ["Nature"],
			publicationDate: null,
			identifier: "9780141439518",
		});
		expect(
			reviewedFromForm({ ...formForBook(book), identifier: "123" }).identifier,
		).toBeNull();
	});

	it("explains each field's problem", () => {
		const form = formForBook(book);
		expect(fieldProblem({ ...form, title: " " }, "title")).toBe(
			"A book needs a title",
		);
		expect(
			fieldProblem(
				{ ...form, publicationDate: "1854-13-45" },
				"publicationDate",
			),
		).toBe("Use a full date");
		expect(
			fieldProblem({ ...form, identifier: "9780141439519" }, "identifier"),
		).toBe("This ISBN's check digit doesn't match");
		expect(fieldProblem({ ...form, identifier: "12345" }, "identifier")).toBe(
			"An ISBN has 10 or 13 digits",
		);
		expect(fieldProblem(form, "identifier")).toBeUndefined();
	});

	it("hyphenates an ISBN once its field is left", () => {
		expect(
			tidyField(
				{ ...formForBook(book), identifier: "9780141439518" },
				"identifier",
			),
		).toEqual({
			identifier: "978-0-14-143951-8",
		});
		expect(
			tidyField({ ...formForBook(book), identifier: "not one" }, "identifier"),
		).toEqual({});
	});

	it("needs a title, and a valid date and ISBN when given", () => {
		const form = formForBook(undefined);
		expect(canAddForm(form)).toBe(false);
		expect(canAddForm({ ...form, title: "A" })).toBe(true);
		expect(
			canAddForm({ ...form, title: "A", publicationDate: "1854-13-45" }),
		).toBe(false);
		expect(canAddForm({ ...form, title: "A", identifier: "12" })).toBe(false);
		expect(isValidDate("1854-08-09")).toBe(true);
		expect(isValidDate("Aug 1854")).toBe(false);
	});
});
