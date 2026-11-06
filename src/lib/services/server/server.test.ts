import { describe, expect, it } from "vitest";
import { createWebServerService } from "./web";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

const serverAnswering = (response: () => Response) =>
	createWebServerService({
		baseUrl: "https://citadel.test",
		fetch: async (request) => {
			expect(new URL(request.url).pathname).toBe("/api/server/update");
			return response();
		},
	});

describe("Web server service", () => {
	it("turns an administrator's update details' dates into dates", async () => {
		const server = serverAnswering(() =>
			json({
				currentVersion: "0.7.1",
				details: {
					checks: "on",
					available: {
						version: "0.8.0",
						url: "https://github.com/everydaythingssoftware/citadel/releases/tag/v0.8.0",
						publishedAt: "2026-11-04T12:00:00Z",
					},
					checkedAt: "2026-11-04T13:00:00Z",
				},
			}),
		);
		const update = await server.update();
		expect(update?.details?.available?.publishedAt).toEqual(
			new Date("2026-11-04T12:00:00Z"),
		);
		expect(update?.details?.checkedAt).toEqual(
			new Date("2026-11-04T13:00:00Z"),
		);
	});

	it("passes a reader's version-only answer through", async () => {
		const server = serverAnswering(() =>
			json({ currentVersion: "0.7.1", details: null }),
		);
		await expect(server.update()).resolves.toEqual({
			currentVersion: "0.7.1",
			details: null,
		});
	});

	it("has nothing to say signed out, and reports other failures", async () => {
		await expect(
			serverAnswering(() =>
				json({ code: "unauthorized", message: "Sign in" }, 401),
			).update(),
		).resolves.toBeNull();
		await expect(
			serverAnswering(() =>
				json({ code: "unavailable", message: "Busy" }, 503),
			).update(),
		).rejects.toThrow("Busy");
	});

	it("reads the public URLs", async () => {
		const listing = {
			addresses: [{ url: "http://nas.local:8081" }],
			configFile: null,
			alwaysIncluded: "http://localhost:8081",
			current: "http://nas.local:8081",
			currentListed: true,
		};
		const server = createWebServerService({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				expect(request.method).toBe("GET");
				expect(new URL(request.url).pathname).toBe("/api/server/addresses");
				return json(listing);
			},
		});
		await expect(server.addresses()).resolves.toEqual(listing);
	});
});
