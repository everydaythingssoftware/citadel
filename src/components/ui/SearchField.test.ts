import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContextMenuButton } from "@/lib/hooks/use-context-menu";
import { SearchField } from "./SearchField";

const describedBy = (html: string) =>
	/aria-describedby="([^"]*)"/.exec(html)?.[1];
const liveRegionId = (html: string) =>
	/<span id="([^"]+)"[^>]*aria-live="polite"/.exec(html)?.[1];

describe("SearchField message", () => {
	it("keeps an empty live region when there is no message", () => {
		const html = renderToStaticMarkup(
			createElement(SearchField, { "aria-label": "Search books" }),
		);
		expect(html).toContain('aria-live="polite"');
		expect(html).not.toContain("aria-invalid");
		expect(describedBy(html)).toBeUndefined();
	});

	it("marks the input invalid and links the error", () => {
		const html = renderToStaticMarkup(
			createElement(SearchField, {
				message: { tone: "error", text: "Missing closing quote." },
			}),
		);
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('data-tone="error"');
		expect(html).toContain("Missing closing quote.");
		expect(describedBy(html)).toBe(liveRegionId(html));
	});

	it("does not let a caller override the error state", () => {
		const html = renderToStaticMarkup(
			createElement(SearchField, {
				"aria-invalid": false,
				message: { tone: "error", text: "e" },
			}),
		);
		expect(html).toContain('aria-invalid="true"');
	});

	it("links a hint without marking the input invalid", () => {
		const html = renderToStaticMarkup(
			createElement(SearchField, { message: { tone: "hint", text: "h" } }),
		);
		expect(html).not.toContain("aria-invalid");
		expect(describedBy(html)).toBe(liveRegionId(html));
	});

	it("keeps the caller's aria-describedby", () => {
		const html = renderToStaticMarkup(
			createElement(SearchField, {
				"aria-describedby": "other",
				message: { tone: "hint", text: "h" },
			}),
		);
		expect(describedBy(html)).toBe(`other ${liveRegionId(html)}`);
	});
});

describe("SearchField scope button", () => {
	const scopeButton = (expanded: boolean): ContextMenuButton => ({
		"aria-haspopup": "menu",
		"aria-expanded": expanded,
		onClick: () => {},
		onKeyDown: () => {},
	});

	it("shows the scope button when scopeButton is set", () => {
		const html = renderToStaticMarkup(
			createElement(SearchField, { scopeButton: scopeButton(false) }),
		);
		expect(html).toContain('aria-label="Search scope"');
		expect(html).toContain('aria-haspopup="menu"');
	});

	it("reports whether the scope menu is open", () => {
		const html = (expanded: boolean) =>
			renderToStaticMarkup(
				createElement(SearchField, { scopeButton: scopeButton(expanded) }),
			);
		expect(html(true)).toContain('aria-expanded="true"');
		expect(html(false)).toContain('aria-expanded="false"');
	});

	it("shows no scope button without scopeButton", () => {
		const html = renderToStaticMarkup(createElement(SearchField, {}));
		expect(html).not.toContain("Search scope");
		expect(html).not.toContain("aria-haspopup");
	});
});
