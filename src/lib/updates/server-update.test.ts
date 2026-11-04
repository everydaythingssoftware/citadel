import { describe, expect, it } from "vitest";
import type { ServerUpdate, ServerVersion } from "@/lib/services/server";
import { serverUpdateRowView } from "./server-update";

const version: ServerVersion = {
	version: "0.7.1",
	commit: "abc123",
	build: "0.7.1+abc123",
};
const update = (overrides: Partial<ServerUpdate>): ServerUpdate => ({
	currentVersion: "0.7.1",
	checks: "on",
	available: null,
	checkedAt: new Date("2026-11-04T12:00:00Z"),
	...overrides,
});

describe("serverUpdateRowView", () => {
	it("shows readers only the version", () => {
		expect(serverUpdateRowView(version, null)).toEqual({
			label: "Citadel 0.7.1",
			description: null,
			releaseNotesUrl: null,
		});
	});

	it("offers administrators a newer release with its notes", () => {
		expect(
			serverUpdateRowView(
				version,
				update({
					available: {
						version: "0.8.0",
						url: "https://notes",
						publishedAt: null,
					},
				}),
			),
		).toEqual({
			label: "Citadel 0.8.0 is available",
			description: "This server runs 0.7.1.",
			releaseNotesUrl: "https://notes",
		});
	});

	it("says why nothing is offered", () => {
		expect(serverUpdateRowView(version, update({})).label).toBe(
			"Citadel 0.7.1 is up to date",
		);
		expect(serverUpdateRowView(version, update({ checkedAt: null }))).toEqual({
			label: "Citadel 0.7.1",
			description: "Checking for updates…",
			releaseNotesUrl: null,
		});
		expect(
			serverUpdateRowView(version, update({ checks: "off" })).description,
		).toBe("Update checks are turned off on this server.");
		expect(
			serverUpdateRowView(version, update({ checks: "notForThisBuild" }))
				.description,
		).toBe("Nightly and development builds don't check for updates.");
	});
});
