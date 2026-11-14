import { describe, expect, it } from "vitest";
import { operatingSystemFrom } from "./os";

const SAFARI_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const EDGE_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0";
const FIREFOX_LINUX =
	"Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

describe("operatingSystemFrom", () => {
	it("reads the user agent when there is no platform hint", () => {
		const os = (userAgent: string, maxTouchPoints = 0) =>
			operatingSystemFrom({ userAgent, maxTouchPoints });
		expect(os(SAFARI_MAC)).toBe("macos");
		expect(os(EDGE_WINDOWS)).toBe("windows");
		expect(os(FIREFOX_LINUX)).toBe("linux");
		expect(os(IPHONE, 5)).toBe("ios");
		expect(os(ANDROID, 5)).toBe("android");
		expect(os("Mozilla/5.0 (PlayStation 5)")).toBe("other");
	});

	it("counts an iPad asking for the desktop site as iOS", () => {
		expect(
			operatingSystemFrom({ userAgent: SAFARI_MAC, maxTouchPoints: 5 }),
		).toBe("ios");
	});

	it("prefers the user-agent client hint's platform", () => {
		expect(
			operatingSystemFrom({
				platform: "macOS",
				userAgent: EDGE_WINDOWS,
				maxTouchPoints: 0,
			}),
		).toBe("macos");
		expect(
			operatingSystemFrom({
				platform: "Windows",
				userAgent: SAFARI_MAC,
				maxTouchPoints: 0,
			}),
		).toBe("windows");
		expect(
			operatingSystemFrom({
				platform: "Chrome OS",
				userAgent: "",
				maxTouchPoints: 0,
			}),
		).toBe("linux");
	});

	it("falls back to the user agent for an unknown or empty hint", () => {
		expect(
			operatingSystemFrom({
				platform: "",
				userAgent: FIREFOX_LINUX,
				maxTouchPoints: 0,
			}),
		).toBe("linux");
		expect(
			operatingSystemFrom({
				platform: "Unknown",
				userAgent: SAFARI_MAC,
				maxTouchPoints: 0,
			}),
		).toBe("macos");
	});
});
