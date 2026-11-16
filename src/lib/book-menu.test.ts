import { describe, expect, it } from "vitest";
import { type BookMenuContext, bookMenuEntries } from "./book-menu";

const macDesktop: BookMenuContext = {
	selectedCount: 1,
	allFinished: false,
	canOpen: true,
	canEdit: true,
	canQuickLook: true,
	canShowInFileManager: true,
	fileManagerName: "Finder",
	canCopyTitle: true,
	canDownload: false,
};

const web: BookMenuContext = {
	...macDesktop,
	canOpen: false,
	canQuickLook: false,
	canShowInFileManager: false,
	fileManagerName: "File Manager",
	canDownload: true,
	canEdit: false,
};

const labels = (context: BookMenuContext) =>
	bookMenuEntries(context).map((entry) =>
		entry.type === "separator" ? "---" : entry.label,
	);

describe("bookMenuEntries", () => {
	it("offers the full single-book menu in the Mac app", () => {
		expect(labels(macDesktop)).toEqual([
			"Show Details",
			"Open",
			"Edit…",
			"Quick Look",
			"---",
			"Mark as Finished",
			"---",
			"Show in Finder",
			"Copy Title",
			"---",
			"Delete…",
		]);
	});

	it("marks the delete item destructive", () => {
		const entry = bookMenuEntries(macDesktop).at(-1);
		expect(entry).toMatchObject({ id: "book-delete", destructive: true });
	});

	it("pluralises and drops single-book items for a multi-selection", () => {
		expect(
			labels({ ...macDesktop, selectedCount: 2, allFinished: true }),
		).toEqual([
			"Open 2 Books",
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
			labels({
				...macDesktop,
				canQuickLook: false,
				fileManagerName: "File Explorer",
			}),
		).toContain("Show in File Explorer");
	});

	it("offers Download instead of Open in a read-only browser library", () => {
		expect(labels(web)).toEqual([
			"Show Details",
			"---",
			"Copy Title",
			"Download",
		]);
	});

	it("is empty with nothing selected", () => {
		expect(bookMenuEntries({ ...macDesktop, selectedCount: 0 })).toEqual([]);
	});
});
