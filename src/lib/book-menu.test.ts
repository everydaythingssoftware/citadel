import { describe, expect, it } from "vitest";
import {
	BOOK_COMMAND,
	type BookCommands,
	bookMenuEntries,
	type TBookCommand,
} from "./book-menu";

const run = () => {};
const commandsOf = (...ids: TBookCommand[]): BookCommands =>
	Object.fromEntries(ids.map((id) => [id, run]));

const everything = commandsOf(...Object.values(BOOK_COMMAND));
const single = { count: 1, allFinished: false, fileManagerName: "Finder" };

const labels = (commands: BookCommands, input = single) =>
	bookMenuEntries(commands, input).map((entry) =>
		entry.type === "separator" ? "---" : entry.label,
	);

describe("bookMenuEntries", () => {
	it("lists the commands present, grouped", () => {
		expect(labels(everything)).toEqual([
			"Show Details",
			"Open",
			"Edit…",
			"Quick Look",
			"---",
			"Mark as Finished",
			"---",
			"Show in Finder",
			"Copy Title",
			"Download",
			"---",
			"Delete…",
		]);
	});

	it("marks the delete item destructive and runs the command", () => {
		const entry = bookMenuEntries(everything, single).at(-1);
		expect(entry).toMatchObject({ id: "book-delete", destructive: true });
		expect(entry?.type === "separator" ? null : entry?.onSelect).toBe(run);
	});

	it("pluralises for a multi-selection", () => {
		expect(
			labels(
				commandsOf(
					BOOK_COMMAND.open,
					BOOK_COMMAND.edit,
					BOOK_COMMAND.toggleFinished,
					BOOK_COMMAND.copyTitle,
					BOOK_COMMAND.delete,
				),
				{ count: 2, allFinished: true, fileManagerName: "Finder" },
			),
		).toEqual([
			"Open 2 Books",
			"Edit 2 Books…",
			"---",
			"Mark as Unfinished",
			"---",
			"Copy 2 Titles",
			"---",
			"Delete 2 Books…",
		]);
	});

	it("names the platform's file manager", () => {
		expect(
			labels(commandsOf(BOOK_COMMAND.showInFileManager), {
				...single,
				fileManagerName: "File Explorer",
			}),
		).toEqual(["Show in File Explorer"]);
	});

	it("drops separators around missing groups", () => {
		expect(
			labels(
				commandsOf(
					BOOK_COMMAND.showDetails,
					BOOK_COMMAND.copyTitle,
					BOOK_COMMAND.download,
				),
			),
		).toEqual(["Show Details", "---", "Copy Title", "Download"]);
	});

	it("is empty with no commands", () => {
		expect(bookMenuEntries({}, single)).toEqual([]);
	});
});
