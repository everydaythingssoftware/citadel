import { describe, expect, it } from "vitest";
import type {
	SoftwareUpdateState,
	SoftwareUpdateStatus,
} from "./software-update";
import {
	backgroundDownloadVersion,
	compareVersions,
	displayVersion,
	updateNoticeTitle,
	updateNoticeVersion,
} from "./update-notice";

const app = (
	status: SoftwareUpdateStatus,
	installOnQuit = true,
): SoftwareUpdateState => ({
	subject: "app",
	currentVersion: "1.3.0",
	status,
	actions: { check: true, install: true, installOnQuit },
});

describe("compareVersions", () => {
	it("compares numerically, part by part", () => {
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.4", "1.4.0")).toBe(0);
		expect(compareVersions("0.8.1", "0.9.0")).toBeLessThan(0);
	});

	it("puts a prerelease before its release", () => {
		expect(compareVersions("1.4.0-nightly.1", "1.4.0")).toBeLessThan(0);
		expect(compareVersions("1.4.0", "1.4.0-nightly.1")).toBeGreaterThan(0);
	});
});

describe("updateNoticeVersion", () => {
	it("shows a downloaded update", () => {
		expect(
			updateNoticeVersion(app({ kind: "ready", version: "1.4.0" }), null),
		).toBe("1.4.0");
	});

	it("shows nothing before the download finishes", () => {
		expect(
			updateNoticeVersion(app({ kind: "available", version: "1.4.0" }), null),
		).toBeNull();
		expect(
			updateNoticeVersion(
				app({ kind: "downloading", version: "1.4.0", progress: 0.5 }),
				null,
			),
		).toBeNull();
	});

	it("shows nothing for installs that can't install at quit", () => {
		expect(
			updateNoticeVersion(
				app({ kind: "ready", version: "1.4.0" }, false),
				null,
			),
		).toBeNull();
	});

	it("shows nothing for a server", () => {
		expect(
			updateNoticeVersion(
				{ ...app({ kind: "ready", version: "1.4.0" }), subject: "server" },
				null,
			),
		).toBeNull();
		expect(updateNoticeVersion(null, null)).toBeNull();
	});

	it("stays hidden for the hidden version, and comes back for a newer one", () => {
		const ready = (version: string) => app({ kind: "ready", version });
		expect(updateNoticeVersion(ready("1.4.0"), "1.4.0")).toBeNull();
		expect(updateNoticeVersion(ready("1.4.0"), "1.5.0")).toBeNull();
		expect(updateNoticeVersion(ready("1.4.1"), "1.4.0")).toBe("1.4.1");
	});
});

describe("backgroundDownloadVersion", () => {
	const available = app({ kind: "available", version: "1.4.0" });

	it("downloads a found update once", () => {
		expect(
			backgroundDownloadVersion(available, {
				automaticChecks: true,
				alreadyRequested: null,
			}),
		).toBe("1.4.0");
		expect(
			backgroundDownloadVersion(available, {
				automaticChecks: true,
				alreadyRequested: "1.4.0",
			}),
		).toBeNull();
	});

	it("leaves updates alone when automatic checks are off", () => {
		expect(
			backgroundDownloadVersion(available, {
				automaticChecks: false,
				alreadyRequested: null,
			}),
		).toBeNull();
	});

	it("leaves installs that can't install at quit to Settings", () => {
		expect(
			backgroundDownloadVersion(
				app({ kind: "available", version: "1.4.0" }, false),
				{
					automaticChecks: true,
					alreadyRequested: null,
				},
			),
		).toBeNull();
	});
});

describe("updateNoticeTitle", () => {
	it("drops a zero patch", () => {
		expect(updateNoticeTitle("1.4.0")).toBe("Citadel 1.4 is ready");
		expect(displayVersion("1.4.2")).toBe("1.4.2");
		expect(displayVersion("1.4.0-nightly.3")).toBe("1.4.0-nightly.3");
	});
});
