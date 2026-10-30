import { describe, expect, it } from "vitest";
import { countdown, describeDeadline, shortRemaining } from "./countdown";

const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 9, 30, 15, 0);
const at = (hours: number) => new Date(now.getTime() + hours * HOUR).toISOString();

describe("review countdown", () => {
	it("drains from the whole window to nothing", () => {
		expect(countdown(at(24), now, 24 * 3600)).toMatchObject({
			fraction: 1,
			urgent: false,
			expired: false,
			short: "24 h left",
		});
		expect(countdown(at(12), now, 24 * 3600).fraction).toBe(0.5);
		expect(countdown(at(-1), now, 24 * 3600)).toMatchObject({
			fraction: 0,
			expired: true,
			urgent: false,
			short: "Time's up",
		});
	});

	it("turns urgent in the last quarter", () => {
		expect(countdown(at(6.1), now, 24 * 3600).urgent).toBe(false);
		expect(countdown(at(5.9), now, 24 * 3600).urgent).toBe(true);
	});

	it("never reports more than the whole window", () => {
		expect(countdown(at(48), now, 24 * 3600).fraction).toBe(1);
	});

	it("describes the deadline relative to today", () => {
		const today = describeDeadline(new Date(2026, 9, 30, 17, 40), now, "en-CA");
		expect(today).toMatch(/^5:40\s?p\.?m\.? today$/);
		expect(describeDeadline(new Date(2026, 9, 31, 9, 5), now, "en-CA")).toMatch(
			/tomorrow$/,
		);
		expect(describeDeadline(new Date(2026, 10, 6, 11, 0), now, "en-CA")).toMatch(
			/on Fri/,
		);
		expect(countdown(at(2), now, 24 * 3600, "en-CA").description).toMatch(
			/^Add or skip by .* today, or it'll be discarded$/,
		);
	});

	it("rounds the time left for a glance", () => {
		expect(shortRemaining(30 * 1000)).toBe("1 min left");
		expect(shortRemaining(59 * 60 * 1000)).toBe("59 min left");
		expect(shortRemaining(3 * HOUR)).toBe("3 h left");
		expect(shortRemaining(72 * HOUR)).toBe("3 days left");
	});
});
