import { describe, expect, it } from "vitest";
import {
	displayedStatus,
	pendingUpdateVersion,
	type SoftwareUpdateState,
	type SoftwareUpdateStatus,
	softwareUpdateRowView,
} from "./software-update";

const state = (
	status: SoftwareUpdateStatus,
	canInstallOnQuit = true,
): SoftwareUpdateState => ({
	currentVersion: "0.7.1",
	status,
	canInstallOnQuit,
});

describe("softwareUpdateRowView", () => {
	it("names the current version until a check finds something", () => {
		expect(softwareUpdateRowView(state({ kind: "idle" }))).toEqual({
			label: "Citadel 0.7.1",
			controls: [{ kind: "check", checking: false }],
		});
		expect(softwareUpdateRowView(state({ kind: "upToDate" })).label).toBe(
			"Citadel 0.7.1 is up to date",
		);
	});

	it("keeps the label while checking, so the row doesn't fade", () => {
		const idle = softwareUpdateRowView(state({ kind: "idle" }));
		const checking = softwareUpdateRowView(state({ kind: "checking" }));
		expect(checking.label).toBe(idle.label);
		expect(checking.controls).toEqual([{ kind: "check", checking: true }]);
	});

	it("offers Later only where the update can install on quit", () => {
		const available = { kind: "available", version: "0.7.2" } as const;
		expect(softwareUpdateRowView(state(available)).controls).toEqual([
			{ kind: "later" },
			{ kind: "updateNow" },
		]);
		expect(softwareUpdateRowView(state(available, false)).controls).toEqual([
			{ kind: "updateNow" },
		]);
	});

	it("keeps the label while downloading and shows progress", () => {
		const view = softwareUpdateRowView(
			state({ kind: "downloading", version: "0.7.2", progress: 0.4 }),
		);
		expect(view.label).toBe("Update available: 0.7.2");
		expect(view.controls).toEqual([
			{ kind: "progress", version: "0.7.2", value: 0.4 },
		]);
	});

	it("says a downloaded update installs at quit", () => {
		expect(
			softwareUpdateRowView(state({ kind: "ready", version: "0.7.2" })),
		).toEqual({
			label: "0.7.2 installs when you quit",
			controls: [{ kind: "restartNow" }],
		});
	});

	it("keeps error details out of the label", () => {
		const view = softwareUpdateRowView(
			state({ kind: "updateFailed", version: "0.7.2", message: "Offline" }),
		);
		expect(view).toEqual({
			label: "Couldn't install 0.7.2",
			detail: "Offline",
			controls: [{ kind: "retryUpdate" }],
		});
	});
});

describe("pendingUpdateVersion", () => {
	it("badges every state with an update waiting", () => {
		expect(pendingUpdateVersion({ kind: "available", version: "0.7.2" })).toBe(
			"0.7.2",
		);
		expect(
			pendingUpdateVersion({
				kind: "downloading",
				version: "0.7.2",
				progress: null,
			}),
		).toBe("0.7.2");
		expect(pendingUpdateVersion({ kind: "ready", version: "0.7.2" })).toBe(
			"0.7.2",
		);
	});

	it("doesn't badge when nothing is waiting", () => {
		expect(pendingUpdateVersion({ kind: "upToDate" })).toBeNull();
		expect(pendingUpdateVersion({ kind: "checking" })).toBeNull();
		expect(
			pendingUpdateVersion({ kind: "checkFailed", message: "Offline" }),
		).toBeNull();
	});
});

describe("displayedStatus", () => {
	const failedCheck = { kind: "checkFailed", message: "Offline" } as const;
	const failedUpdate = {
		kind: "updateFailed",
		version: "0.7.2",
		message: "Offline",
	} as const;

	it("shows the real status when no press is being held", () => {
		expect(displayedStatus(failedCheck, null)).toBe(failedCheck);
	});

	it("holds a check's spinner over an instant answer", () => {
		expect(displayedStatus(failedCheck, "check")).toEqual({ kind: "checking" });
		expect(displayedStatus({ kind: "upToDate" }, "check")).toEqual({
			kind: "checking",
		});
	});

	it("holds an update's progress bar over an instant failure", () => {
		expect(displayedStatus(failedUpdate, "update")).toEqual({
			kind: "downloading",
			version: "0.7.2",
			progress: null,
		});
	});

	it("lets real progress through", () => {
		const downloading = {
			kind: "downloading",
			version: "0.7.2",
			progress: 0.3,
		} as const;
		expect(displayedStatus(downloading, "update")).toBe(downloading);
	});

	it("leaves states with nothing to download alone", () => {
		const ready = { kind: "ready", version: "0.7.2" } as const;
		expect(displayedStatus(ready, "update")).toBe(ready);
	});
});
