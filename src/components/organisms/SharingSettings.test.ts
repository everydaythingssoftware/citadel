import { describe, expect, it } from "vitest";
import { deviceKeyUsage } from "@/components/organisms/SharingSettings";

const NOV_5_2026 = Date.UTC(2026, 10, 5, 12) / 1_000;

describe("deviceKeyUsage", () => {
	it("says a key that never signed in was never used", () => {
		const usage = deviceKeyUsage({
			id: "k",
			name: "Kobo",
			createdAt: NOV_5_2026,
			lastUsedAt: null,
		});
		expect(usage).toMatch(/^Added .*2026 · Never used$/);
	});

	it("shows when a key last signed in", () => {
		const usage = deviceKeyUsage({
			id: "k",
			name: "Kobo",
			createdAt: NOV_5_2026,
			lastUsedAt: NOV_5_2026,
		});
		expect(usage).toMatch(/· Last used .*2026$/);
	});
});
