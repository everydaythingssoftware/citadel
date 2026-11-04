import { describe, expect, it } from "vitest";
import { createWebServerService } from "./web";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("Web server service", () => {
	it("reads the server's version without signing in", async () => {
		const server = createWebServerService({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				expect(new URL(request.url).pathname).toBe("/api/version");
				return json({
					version: "0.8.0",
					commit: "abc123",
					build: "0.8.0+abc123",
				});
			},
		});
		await expect(server.version()).resolves.toEqual({
			version: "0.8.0",
			commit: "abc123",
			build: "0.8.0+abc123",
		});
	});

	it("turns the update answer's dates into dates", async () => {
		const server = createWebServerService({
			baseUrl: "https://citadel.test",
			fetch: async () =>
				json({
					currentVersion: "0.7.1",
					checks: "on",
					available: {
						version: "0.8.0",
						url: "https://github.com/everydaythingssoftware/citadel/releases/tag/v0.8.0",
						publishedAt: "2026-11-04T12:00:00Z",
					},
					checkedAt: "2026-11-04T13:00:00Z",
				}),
		});
		const update = await server.update();
		expect(update?.available?.publishedAt).toEqual(
			new Date("2026-11-04T12:00:00Z"),
		);
		expect(update?.checkedAt).toEqual(new Date("2026-11-04T13:00:00Z"));
	});

	it("tells readers nothing about updates", async () => {
		for (const status of [401, 403]) {
			const server = createWebServerService({
				baseUrl: "https://citadel.test",
				fetch: async () =>
					json({ code: "unauthorized", message: "No" }, status),
			});
			await expect(server.update()).resolves.toBeNull();
		}
	});
});
