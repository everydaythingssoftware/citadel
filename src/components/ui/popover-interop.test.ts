import { describe, expect, it, vi } from "vitest";
import { isOpenCombobox, keepOpenForList } from "./popover-interop";

const target = (attributes: Record<string, string>) => ({
	getAttribute: (name: string) => attributes[name] ?? null,
});

describe("isOpenCombobox", () => {
	it("gives true for a combobox that shows its list", () => {
		expect(
			isOpenCombobox(target({ role: "combobox", "aria-expanded": "true" })),
		).toBe(true);
	});

	it("gives false for a combobox with its list closed", () => {
		expect(
			isOpenCombobox(target({ role: "combobox", "aria-expanded": "false" })),
		).toBe(false);
		expect(isOpenCombobox(target({ role: "combobox" }))).toBe(false);
	});

	it("gives false for an expanded control that is not a combobox", () => {
		expect(
			isOpenCombobox(target({ role: "button", "aria-expanded": "true" })),
		).toBe(false);
		expect(isOpenCombobox(target({}))).toBe(false);
	});

	it("gives false for no target", () => {
		expect(isOpenCombobox(null)).toBe(false);
	});
});

describe("keepOpenForList", () => {
	const pressEscape = (attributes: Record<string, string>) => {
		const event = { target: target(attributes), preventDefault: vi.fn() };
		keepOpenForList(event as unknown as KeyboardEvent);
		return event.preventDefault;
	};

	it("keeps the dialog open for an Escape in an open completion list", () => {
		expect(
			pressEscape({ role: "combobox", "aria-expanded": "true" }),
		).toHaveBeenCalled();
	});

	it("lets each other Escape close the dialog", () => {
		expect(
			pressEscape({ role: "combobox", "aria-expanded": "false" }),
		).not.toHaveBeenCalled();
		expect(pressEscape({})).not.toHaveBeenCalled();
	});
});
