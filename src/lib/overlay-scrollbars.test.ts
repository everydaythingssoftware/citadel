import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installScrollActivity,
	needsOverlayScrollbars,
} from "./overlay-scrollbars";

const fakeElement = () => {
	const attributes = new Set<string>();
	return {
		attributes,
		setAttribute: (name: string) => attributes.add(name),
		removeAttribute: (name: string) => attributes.delete(name),
	};
};

const fakeDocument = () => {
	const root = fakeElement();
	let listener: ((event: Event) => void) | null = null;
	const doc = {
		documentElement: root,
		addEventListener: (_: string, handler: (event: Event) => void) => {
			listener = handler;
		},
		removeEventListener: () => {
			listener = null;
		},
	};
	const scroll = (target: unknown) =>
		listener?.({ target } as unknown as Event);
	return { doc: doc as unknown as Document, root, scroll };
};

afterEach(() => {
	vi.useRealTimers();
});

describe("needsOverlayScrollbars", () => {
	it("leaves macOS and mobile to the system", () => {
		expect(needsOverlayScrollbars("macos")).toBe(false);
		expect(needsOverlayScrollbars("ios")).toBe(false);
		expect(needsOverlayScrollbars("android")).toBe(false);
		expect(needsOverlayScrollbars("windows")).toBe(true);
		expect(needsOverlayScrollbars("linux")).toBe(true);
	});
});

describe("installScrollActivity", () => {
	it("marks a scroller while it scrolls and clears it once it rests", () => {
		vi.useFakeTimers();
		const { doc, root, scroll } = fakeDocument();
		const list = fakeElement();
		const uninstall = installScrollActivity(doc, 100);

		scroll(list);
		expect(list.attributes.has("data-scrolling")).toBe(true);
		vi.advanceTimersByTime(60);
		scroll(list);
		vi.advanceTimersByTime(60);
		expect(list.attributes.has("data-scrolling")).toBe(true);
		vi.advanceTimersByTime(60);
		expect(list.attributes.has("data-scrolling")).toBe(false);

		scroll({});
		expect(root.attributes.has("data-scrolling")).toBe(true);
		uninstall();
		expect(root.attributes.has("data-scrolling")).toBe(false);
	});
});
