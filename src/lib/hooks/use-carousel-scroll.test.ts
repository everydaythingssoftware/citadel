import { describe, expect, it } from "vitest";
import { stretchFor } from "./use-carousel-scroll";

describe("carousel rubber band", () => {
	it("gives less the further you pull, in the pull's direction, never past its limit", () => {
		const small = stretchFor(20);
		const large = stretchFor(400);
		expect(small).toBeGreaterThan(0);
		expect(large).toBeGreaterThan(small);
		expect(large / 400).toBeLessThan(small / 20);
		expect(stretchFor(100_000)).toBeLessThan(56);
		expect(stretchFor(-20)).toBe(-small);
		expect(stretchFor(0)).toBe(0);
	});
});
