import { describe, expect, it } from "vitest";
import { abbreviateHomePath } from "./use-home-dir";

describe("abbreviateHomePath", () => {
	it("preserves either separator after the tilde", () => {
		expect(abbreviateHomePath("/Users/me/Books", "/Users/me")).toBe("~/Books");
		expect(
			abbreviateHomePath(
				String.raw`C:\Users\me\Books`,
				String.raw`C:\Users\me`,
			),
		).toBe(String.raw`~\Books`);
		expect(abbreviateHomePath("C:/Users/me/Books", "C:/Users/me")).toBe(
			"~/Books",
		);
	});
	it("only shortens the home directory and its descendants", () => {
		expect(abbreviateHomePath("/Users/me", "/Users/me")).toBe("~");
		expect(abbreviateHomePath("/Users/me-too/Books", "/Users/me")).toBe(
			"/Users/me-too/Books",
		);
		expect(abbreviateHomePath("/Books", null)).toBe("/Books");
	});
});
