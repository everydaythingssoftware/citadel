import { describe, expect, it } from "vitest";
import type { CoverColors } from "@/bindings";
import { coverPlaceholder } from "./cover-placeholder";

const palette: CoverColors["palette"] = {
	dominant: { l: 0.4218, a: -0.0273, b: -0.0762, share: 1 },
	secondary: null,
};

describe("coverPlaceholder", () => {
	it("prefers the ThumbHash, then the dominant colour, then nothing", () => {
		const hashed = coverPlaceholder({
			palette,
			thumbhash: "FLYBBQCGhnh4h4iHd3eH9weH+Ed4",
		});
		expect(hashed?.backgroundImage).toMatch(/^url\("data:image\/png;base64,/);
		expect(hashed?.backgroundColor).toBeUndefined();

		expect(coverPlaceholder({ palette, thumbhash: "" })).toEqual({
			backgroundColor: "oklab(42.2% -0.027 -0.076)",
		});

		expect(coverPlaceholder({ palette: null, thumbhash: "" })).toBeUndefined();
		expect(coverPlaceholder(null)).toBeUndefined();
		expect(coverPlaceholder(undefined)).toBeUndefined();
	});
});
