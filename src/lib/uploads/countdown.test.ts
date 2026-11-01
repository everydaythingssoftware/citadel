import { describe, expect, it } from "vitest";
import { countdown, describeDeadline } from "./countdown";

const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 9, 30, 15, 0);
const at = (hours: number) =>
	new Date(now.getTime() + hours * HOUR).toISOString();

describe("review countdown", () => {
	it("says when drafts have expired, without calling for attention", () => {
		expect(countdown(at(-1), now, 24 * 3600)).toEqual({
			urgent: false,
			description: "These drafts have expired",
		});
	});

	it("turns urgent in the last quarter", () => {
		expect(countdown(at(6.1), now, 24 * 3600).urgent).toBe(false);
		expect(countdown(at(5.9), now, 24 * 3600).urgent).toBe(true);
	});

	it("stays calm with more than the whole window left", () => {
		expect(countdown(at(48), now, 24 * 3600).urgent).toBe(false);
	});

	it("describes the deadline relative to today", () => {
		const today = describeDeadline(new Date(2026, 9, 30, 17, 40), now, "en-CA");
		expect(today).toMatch(/^5:40\s?p\.?m\.? today$/);
		expect(describeDeadline(new Date(2026, 9, 31, 9, 5), now, "en-CA")).toMatch(
			/tomorrow$/,
		);
		expect(
			describeDeadline(new Date(2026, 10, 6, 11, 0), now, "en-CA"),
		).toMatch(/on Fri/);
		expect(countdown(at(2), now, 24 * 3600, "en-CA").description).toMatch(
			/^Drafts kept until .* today$/,
		);
	});
});
