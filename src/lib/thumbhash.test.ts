import { describe, expect, it } from "vitest";
import { thumbHashToDataURL, thumbHashToRGBA } from "./thumbhash";

/**
 * The hash citadel-core's cover_colors gives a solid rgb(40, 80, 120)
 * 600×900 cover (pinned in its cover_colors_reads_a_decoded_image test).
 */
const SOLID_BLUE = "FLYBBQCGhnh4h4iHd3eH9weH+Ed4";

const bytes = (base64: string): Uint8Array =>
	Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

describe("thumbHashToRGBA", () => {
	it("decodes the Rust ThumbHash of a solid cover back to its colour", () => {
		const { w, h, rgba } = thumbHashToRGBA(bytes(SOLID_BLUE));
		// Portrait, about 2:3 like the cover.
		expect(h).toBe(32);
		expect(w).toBeLessThan(h);
		expect(rgba).toHaveLength(w * h * 4);
		for (let i = 0; i < rgba.length; i += 4) {
			expect(Math.abs((rgba[i] ?? 0) - 40)).toBeLessThanOrEqual(6);
			expect(Math.abs((rgba[i + 1] ?? 0) - 80)).toBeLessThanOrEqual(6);
			expect(Math.abs((rgba[i + 2] ?? 0) - 120)).toBeLessThanOrEqual(6);
			expect(rgba[i + 3]).toBe(255);
		}
		expect(thumbHashToDataURL(SOLID_BLUE)).toMatch(
			/^data:image\/png;base64,iVBORw0KGgo/,
		);
	});
});
