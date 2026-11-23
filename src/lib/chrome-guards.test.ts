import { dispatchKeymapEvent } from "@/lib/hooks/use-keymap";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	allowsBrowserContextMenu,
	blocksBrowserKey,
	browserGuardedEvents,
	installChromeGuards,
	allowsDragStart,
	allowsNativeSelectAll,
	type GuardTarget,
	selectableFromStyles,
} from "./chrome-guards";

describe("selectableFromStyles", () => {
	it("lets the nearest decisive user-select win", () => {
		expect(selectableFromStyles(["auto", "text", "none"])).toBe(true);
		expect(selectableFromStyles(["auto", "none", "text"])).toBe(false);
		expect(selectableFromStyles(["all"])).toBe(true);
		expect(selectableFromStyles(["auto", "auto"])).toBe(false);
	});

	it("opens the browser menu over CSS-selectable text with a selection", () => {
		expect(allowsBrowserContextMenu(inside(), "Dune", true)).toBe(true);
		expect(allowsBrowserContextMenu(inside(), "", true)).toBe(false);
	});
});

/** A target inside elements matching these selector fragments. */
const inside = (...fragments: string[]): GuardTarget => ({
	closest: (selector) =>
		fragments.some((fragment) => selector.includes(fragment)) ? {} : null,
});

const CHROME = inside();

describe("allowsBrowserContextMenu", () => {
	it("blocks the browser menu over chrome and images", () => {
		expect(allowsBrowserContextMenu(CHROME, "")).toBe(false);
		expect(allowsBrowserContextMenu(inside("img"), "")).toBe(false);
		expect(allowsBrowserContextMenu(null, "")).toBe(false);
	});

	it("keeps it in text fields and editable text", () => {
		expect(allowsBrowserContextMenu(inside("textarea"), "")).toBe(true);
		expect(allowsBrowserContextMenu(inside("[contenteditable]"), "")).toBe(
			true,
		);
		expect(allowsBrowserContextMenu(inside("[type='search']"), "")).toBe(true);
	});

	it("keeps it over selectable content only while text is selected", () => {
		expect(allowsBrowserContextMenu(inside("[data-selectable]"), "")).toBe(
			false,
		);
		expect(allowsBrowserContextMenu(inside("[data-selectable]"), "  ")).toBe(
			false,
		);
		expect(allowsBrowserContextMenu(inside(".ctd-selectable"), "a quote")).toBe(
			true,
		);
		expect(allowsBrowserContextMenu(CHROME, "a quote")).toBe(false);
	});
});

describe("allowsNativeSelectAll", () => {
	it("selects all only inside fields", () => {
		expect(allowsNativeSelectAll(inside("textarea"))).toBe(true);
		expect(allowsNativeSelectAll(inside("[data-selectable]"))).toBe(false);
		expect(allowsNativeSelectAll(CHROME)).toBe(false);
	});
});

describe("Select All over the chrome", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("cancels the browser's Select All without stopping the app's", () => {
		class ChromeElement {
			closest() {
				return null;
			}
		}
		vi.stubGlobal("Element", ChromeElement);
		vi.stubGlobal("Node", class {});
		const listeners = new Map<string, EventListener>();
		const doc = {
			addEventListener: (
				name: string,
				listener: EventListener,
				options?: boolean | AddEventListenerOptions,
			) => {
				const capture =
					options === true || (typeof options === "object" && options.capture);
				listeners.set(`${name}:${!!capture}`, listener);
			},
			removeEventListener: () => {},
			getSelection: () => null,
		} as unknown as Document;
		installChromeGuards(doc, { os: "macos", desktop: true });
		const event = {
			key: "a",
			ctrlKey: true,
			shiftKey: false,
			altKey: false,
			metaKey: false,
			target: new ChromeElement(),
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		listeners.get("keydown:false")?.(event as unknown as Event);
		expect(event.defaultPrevented).toBe(true);
		let selections = 0;
		dispatchKeymapEvent(
			[
				{
					chord: "mod+a",
					onMatch: () => {
						selections++;
					},
				},
			],
			event as unknown as KeyboardEvent,
		);
		expect(selections).toBe(1);
	});
});

describe("allowsDragStart", () => {
	it("stops links and images dragging out unless marked draggable", () => {
		expect(allowsDragStart(inside("img"))).toBe(false);
		expect(allowsDragStart(inside("a, "))).toBe(false);
		expect(allowsDragStart(inside("img", '[draggable="true"]'))).toBe(true);
		expect(allowsDragStart(CHROME)).toBe(true);
	});
});

describe("Windows browser accelerators", () => {
	const key = (key: string, ctrlKey = false, shiftKey = false) => ({
		key,
		ctrlKey,
		shiftKey,
		altKey: false,
		metaKey: false,
	});
	it("blocks browser navigation, printing, search, caret browsing and zoom", () => {
		for (const event of [
			key("F5"),
			key("F3"),
			key("F7"),
			...["r", "p", "f", "g", "u", "-", "=", "0"].map((k) => key(k, true)),
			key("R", true, true),
			key("G", true, true),
			key("+", true, true),
		]) {
			expect(blocksBrowserKey(event, "windows", true)).toBe(true);
			expect(blocksBrowserKey(event, "macos", true)).toBe(false);
			expect(blocksBrowserKey(event, "linux", true)).toBe(false);
			expect(blocksBrowserKey(event, "windows", false)).toBe(false);
		}
	});
	it("leaves editing, app window commands and devtools alone", () => {
		for (const event of [
			key("c", true),
			key("v", true),
			key("a", true),
			key("F11"),
			key("F12"),
			key("I", true, true),
			key("L", true, true),
			key("w", true),
		])
			expect(blocksBrowserKey(event, "windows", true)).toBe(false);
	});
	it("cancels browser defaults in capture without stopping app command delivery", () => {
		const listeners = new Map<string, EventListener>();
		const removed: string[] = [];
		const doc = {
			addEventListener: (
				name: string,
				listener: EventListener,
				options?: boolean | AddEventListenerOptions,
			) => {
				const capture =
					options === true || (typeof options === "object" && options.capture);
				listeners.set(`${name}:${!!capture}`, listener);
			},
			removeEventListener: (name: string) => removed.push(name),
		} as unknown as Document;
		const stop = installChromeGuards(doc, { os: "windows", desktop: true });
		const event = {
			...key("f", true),
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		listeners.get("keydown:true")?.(event as unknown as Event);
		expect(event.defaultPrevented).toBe(true);
		expect(browserGuardedEvents.has(event as KeyboardEvent)).toBe(true);
		let finds = 0;
		dispatchKeymapEvent(
			[
				{
					chord: "mod+f",
					when: () => false,
					onMatch: () => {
						finds++;
					},
				},
			],
			event as KeyboardEvent,
		);
		expect(finds).toBe(0);
		expect(event.defaultPrevented).toBe(true);
		const bindings = [
			{
				chord: "mod+f",
				onMatch: () => {
					finds++;
				},
			},
		];
		dispatchKeymapEvent(bindings, event as KeyboardEvent);
		dispatchKeymapEvent(bindings, event as KeyboardEvent);
		expect(finds).toBe(1);

		const wheel = {
			ctrlKey: true,
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		listeners.get("wheel:true")?.(wheel as unknown as Event);
		expect(wheel.defaultPrevented).toBe(true);
		stop();
		expect(removed).toContain("wheel");
		expect(removed.filter((name) => name === "keydown")).toHaveLength(2);
	});
});
