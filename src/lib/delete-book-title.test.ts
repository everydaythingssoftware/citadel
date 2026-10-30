import { describe, expect, it } from "vitest";
import { deleteBookCopy } from "./delete-book-title";

describe("deleteBookCopy", () => {
	it("offers recovery from the Trash on desktop", () => {
		const copy = deleteBookCopy("trash");
		expect(copy.confirmLabel).toBe("Move to Trash");
		expect(copy.description).toContain("recover");
	});

	it("says server deletion can't be undone", () => {
		const copy = deleteBookCopy("permanent");
		expect(copy.confirmLabel).toBe("Delete Permanently");
		expect(copy.description).toContain("can't be undone");
		expect(copy.failureTitle).not.toContain("Trash");
	});
});
