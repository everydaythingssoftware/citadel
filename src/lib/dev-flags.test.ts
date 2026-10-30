import { afterEach, describe, expect, it, vi } from "vitest";
import { devFlag } from "./dev-flags";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("developer flags", () => {
	it("reads a known value and falls back to the default otherwise", () => {
		const stored: Record<string, string> = {
			"citadel:hourglass": "ring",
			"citadel:dropFan": "nonsense",
		};
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => stored[key] ?? null,
		});
		expect(devFlag("hourglass")).toBe("ring");
		expect(devFlag("dropFan")).toBe("paintings");
		expect(devFlag("addedMotion")).toBe("deal");
	});

	it("falls back when storage throws", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("blocked");
			},
		});
		expect(devFlag("placeholderCovers")).toBe("paintings");
	});
});
