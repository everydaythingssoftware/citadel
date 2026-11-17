import { describe, expect, it } from "vitest";
import { none, some } from "@/lib/option";
import type {
	SoftwareUpdateState,
	SoftwareUpdateStatus,
} from "./software-update";
import {
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

describe("updateNoticeVersion", () => {
	it("shows a downloaded update", () => {
		expect(
			updateNoticeVersion(app({ kind: "ready", version: "1.4.0" }), null),
		).toEqual(some("1.4.0"));
	});

	it("shows nothing before the download finishes", () => {
		expect(
			updateNoticeVersion(app({ kind: "available", version: "1.4.0" }), null),
		).toEqual(none());
		expect(
			updateNoticeVersion(
				app({ kind: "downloading", version: "1.4.0", progress: 0.5 }),
				null,
			),
		).toEqual(none());
	});

	it("shows nothing for installs that can't install at quit", () => {
		expect(
			updateNoticeVersion(
				app({ kind: "ready", version: "1.4.0" }, false),
				null,
			),
		).toEqual(none());
	});

	it("shows nothing for a server", () => {
		expect(
			updateNoticeVersion(
				{ ...app({ kind: "ready", version: "1.4.0" }), subject: "server" },
				null,
			),
		).toEqual(none());
		expect(updateNoticeVersion(null, null)).toEqual(none());
	});

	it("stays hidden for the hidden version, and comes back for another one", () => {
		const ready = (version: string) => app({ kind: "ready", version });
		expect(updateNoticeVersion(ready("1.4.0"), "1.4.0")).toEqual(none());
		expect(updateNoticeVersion(ready("1.4.1"), "1.4.0")).toEqual(some("1.4.1"));
	});
});

describe("updateNoticeTitle", () => {
	it("drops a zero patch", () => {
		expect(updateNoticeTitle("1.4.0")).toBe("Citadel 1.4 is ready");
		expect(displayVersion("1.4.2")).toBe("1.4.2");
		expect(displayVersion("1.4.0-nightly.3")).toBe("1.4.0-nightly.3");
	});
});
