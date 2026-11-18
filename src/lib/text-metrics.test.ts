import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTextMetrics } from "./text-metrics";

const attributes = new Map<string, string>();

beforeEach(() => {
	attributes.clear();
	vi.stubGlobal("document", {
		documentElement: {
			setAttribute: (name: string, value: string) => {
				attributes.set(name, value);
			},
			removeAttribute: (name: string) => {
				attributes.delete(name);
			},
		},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("applyTextMetrics", () => {
	it("marks the document when Apple's metrics are on", () => {
		applyTextMetrics(true);
		expect(attributes.get("data-text-metrics")).toBe("apple");
	});

	it("removes the mark when they are turned off again", () => {
		applyTextMetrics(true);
		applyTextMetrics(false);
		expect(attributes.has("data-text-metrics")).toBe(false);
	});
});
