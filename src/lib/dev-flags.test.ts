import { afterEach, describe, expect, it, vi } from "vitest";
import { devFlag } from "./dev-flags";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("developer flags", () => {
	it("reads a known value and falls back to the default otherwise", () => {
		const stored: Record<string, string> = {
			"citadel:reviewIndicator": "download",
			"citadel:dropFan": "nonsense",
		};
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => stored[key] ?? null,
		});
		expect(devFlag("reviewIndicator")).toBe("download");
		expect(devFlag("dropFan")).toBe("paintings");
		expect(devFlag("addedMotion")).toBe("deal");
	});

	it("takes a flag from the address and remembers it", () => {
		const stored: Record<string, string> = {};
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => stored[key] ?? null,
			setItem: (key: string, value: string) => {
				stored[key] = value;
			},
		});
		vi.stubGlobal("location", {
			search: "?touchCovers=physics&dropFan=nope",
		});
		expect(devFlag("touchCovers")).toBe("physics");
		expect(devFlag("dropFan")).toBe("paintings");
		vi.stubGlobal("location", { search: "" });
		expect(devFlag("touchCovers")).toBe("physics");
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
