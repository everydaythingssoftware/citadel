import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/server", () => ({ serverService: {} }));

import { trustedProxyRows } from "./use-proxy-trust-offer";

const proxies = (configured: string[] | null, trusted: string[]) => ({
	configured,
	trusted,
	forwardedHeader: "x-forwarded-for",
	untrusted: [],
});

describe("trustedProxyRows", () => {
	it("lists configured proxies read-only, then those trusted from Settings", () => {
		expect(trustedProxyRows(proxies(["10.0.0.0/8"], ["192.168.97.3"]))).toEqual(
			[
				{ range: "10.0.0.0/8", removable: false },
				{ range: "192.168.97.3", removable: true },
			],
		);
	});

	it("lists a proxy in both places once, as configured", () => {
		expect(trustedProxyRows(proxies(["172.18.0.5"], ["172.18.0.5"]))).toEqual([
			{ range: "172.18.0.5", removable: false },
		]);
	});

	it("is empty when nothing is trusted", () => {
		expect(trustedProxyRows(proxies(null, []))).toEqual([]);
	});
});
