import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerUpdate } from "@/lib/services/server";
import { NO_UPDATE_ACTIONS } from "@/lib/updates/software-update";
import { createWebUpdates } from "./web";

const answering = (update: ServerUpdate | null) =>
	createWebUpdates({ update: async () => update });

const administrator = (
	details: Partial<NonNullable<ServerUpdate["details"]>>,
): ServerUpdate => ({
	currentVersion: "0.7.1",
	details: {
		checks: "on",
		available: null,
		checkedAt: new Date("2026-11-04T12:00:00Z"),
		...details,
	},
});

afterEach(() => {
	vi.useRealTimers();
});

describe("web updates", () => {
	it("is about the server and offers no actions", async () => {
		const state = await answering(administrator({})).state();
		expect(state).toEqual({
			subject: "server",
			currentVersion: "0.7.1",
			status: { kind: "upToDate" },
			actions: NO_UPDATE_ACTIONS,
		});
	});

	it("gives readers the version and no update information", async () => {
		const state = await answering({
			currentVersion: "0.7.1",
			details: null,
		}).state();
		expect(state?.status).toEqual({ kind: "idle" });
	});

	it("offers a newer release with its notes", async () => {
		const state = await answering(
			administrator({
				available: {
					version: "0.8.0",
					url: "https://notes",
					publishedAt: null,
				},
			}),
		).state();
		expect(state?.status).toEqual({
			kind: "available",
			version: "0.8.0",
			releaseNotesUrl: "https://notes",
		});
	});

	it("says why it can't tell", async () => {
		const status = async (details: Parameters<typeof administrator>[0]) =>
			(await answering(administrator(details)).state())?.status;
		expect(await status({ checks: "off" })).toEqual({ kind: "checksOff" });
		expect(await status({ checks: "notForThisBuild" })).toEqual({
			kind: "notForThisBuild",
		});
		expect(await status({ checkedAt: null })).toEqual({ kind: "checking" });
	});

	it("has nothing to show signed out", async () => {
		await expect(answering(null).state()).resolves.toBeNull();
	});

	it("asks the server again on its schedule until stopped", async () => {
		vi.useFakeTimers();
		let answer = administrator({});
		const updates = createWebUpdates({ update: async () => answer }, 1000);
		const seen: string[] = [];
		const stop = await updates.onChange((state) =>
			seen.push(state.status.kind),
		);
		answer = administrator({
			available: { version: "0.8.0", url: "https://notes", publishedAt: null },
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(seen).toEqual(["available"]);
		stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(seen).toEqual(["available"]);
	});
});
