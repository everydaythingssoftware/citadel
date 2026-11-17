import { describe, expect, it } from "vitest";
import type { OpdsServiceStatus } from "@/bindings";
import { newestStatus, startOutcome } from "@/lib/hooks/use-opds-sharing";

const status = (patch: Partial<OpdsServiceStatus>): OpdsServiceStatus => ({
	state: "running",
	activeLibraryId: "library",
	urls: ["http://192.168.1.5:9028/opds"],
	error: null,
	config: null,
	...patch,
});

describe("startOutcome", () => {
	it("treats a running share as success", () => {
		expect(startOutcome({ ok: true, value: status({}) })).toEqual({ ok: true });
	});

	it("treats waiting for an interface as success", () => {
		const waiting = status({ state: "waitingForInterface", urls: [] });
		expect(startOutcome({ ok: true, value: waiting })).toEqual({ ok: true });
	});

	it("treats an error-state status as failure with the backend message", () => {
		const failed = status({
			state: "error",
			urls: [],
			error: { code: "portUnavailable", message: "Port 9030 is in use." },
		});
		expect(startOutcome({ ok: true, value: failed })).toEqual({
			ok: false,
			error: {
				source: "server",
				code: "portUnavailable",
				message: "Port 9030 is in use.",
			},
		});
	});

	it("passes a rejected command through", () => {
		const rejected = {
			ok: false,
			error: { source: "server", code: null, message: "Open a library first." },
		} as const;
		expect(startOutcome(rejected)).toEqual(rejected);
	});
});

describe("newestStatus", () => {
	const read = status({ state: "running" });
	const died = status({ state: "error", urls: [] });

	it("keeps the read when nothing was announced during it", () => {
		expect(newestStatus(read, 3, { status: died, count: 3 })).toBe(read);
	});

	it("prefers a change announced while the read was in flight", () => {
		expect(newestStatus(read, 3, { status: died, count: 4 })).toBe(died);
	});
});
