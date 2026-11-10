import { describe, expect, it } from "vitest";
import { fileManagerNameFor } from "./file-manager-name";

describe("fileManagerNameFor", () => {
	it("names each platform's file manager", () => {
		expect(
			fileManagerNameFor(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
			),
		).toBe("Finder");
		expect(
			fileManagerNameFor(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120",
			),
		).toBe("File Explorer");
		expect(
			fileManagerNameFor(
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
			),
		).toBe("File Manager");
	});
});
