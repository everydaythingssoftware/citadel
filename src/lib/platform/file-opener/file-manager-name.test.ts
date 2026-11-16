import { describe, expect, it } from "vitest";
import { fileManagerNameFor } from "./file-manager-name";

describe("fileManagerNameFor", () => {
	it("names each platform's file manager", () => {
		expect(fileManagerNameFor("macos")).toBe("Finder");
		expect(fileManagerNameFor("windows")).toBe("File Explorer");
		expect(fileManagerNameFor("ios")).toBe("Files");
		expect(fileManagerNameFor("linux")).toBe("File Manager");
		expect(fileManagerNameFor("android")).toBe("File Manager");
		expect(fileManagerNameFor("other")).toBe("File Manager");
	});
});
