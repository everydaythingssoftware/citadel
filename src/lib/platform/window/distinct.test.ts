import { describe, expect, it, vi } from "vitest";
import { distinct } from "./distinct";

describe("distinct", () => {
	it("drops repeats of the last value", () => {
		const handler = vi.fn();
		const report = distinct(handler);
		report(true);
		report(true);
		report(false);
		report(true);
		expect(handler.mock.calls).toEqual([[true], [false], [true]]);
	});
});
