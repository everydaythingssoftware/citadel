import { describe, expect, it } from "vitest";
import { deviceKeyUsage } from "./device-keys";

const at = (year: number, month: number, day: number, hour = 12): number =>
	new Date(year, month - 1, day, hour).getTime() / 1_000;

const key = (lastUsedAt: number | null) => ({
	id: "k",
	name: "Kobo",
	createdAt: at(2026, 10, 1),
	lastUsedAt,
});

describe("deviceKeyUsage", () => {
	const now = new Date(2026, 10, 5, 9);

	it("says a key that never signed in was never used", () => {
		expect(deviceKeyUsage(key(null), now)).toMatch(/^Added .* · Never used$/);
	});

	it("counts calendar days, not 24-hour periods", () => {
		expect(deviceKeyUsage(key(at(2026, 11, 5, 1)), now)).toMatch(
			/· Last used today$/,
		);
		expect(deviceKeyUsage(key(at(2026, 11, 4, 23)), now)).toMatch(
			/· Last used yesterday$/,
		);
	});

	it("shows a date for anything older", () => {
		expect(deviceKeyUsage(key(at(2026, 11, 3)), now)).toMatch(
			/· Last used .*2026$/,
		);
	});
});
