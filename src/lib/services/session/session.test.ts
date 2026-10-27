import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSession } from ".";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
const session = {
	user: { id: "user-1", username: "reader" },
	libraryAccess: true,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("browser session", () => {
	it("reports no session on 401 and the signed-in user otherwise", async () => {
		const requests: Request[] = [];
		const responses = [
			json({ code: "unauthorized", message: "Sign in to Citadel" }, 401),
			json(session),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				requests.push(request);
				return responses.shift();
			}),
		);
		const service = createBrowserSession("https://citadel.test");
		expect(await service.current()).toBeNull();
		expect(await service.current()).toEqual(session);
		expect(requests[0]?.url).toBe("https://citadel.test/api/session");
		expect(requests[0]?.credentials).toBe("same-origin");
	});

	it("posts credentials to sign in and surfaces the server's message", async () => {
		const bodies: unknown[] = [];
		const responses = [
			json(session),
			json(
				{ code: "unauthorized", message: "Incorrect username or password" },
				401,
			),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				expect(request.method).toBe("POST");
				bodies.push(await request.json());
				return responses.shift();
			}),
		);
		const service = createBrowserSession("https://citadel.test");
		expect(await service.signIn("reader", "secret-password")).toEqual(session);
		await expect(service.signIn("reader", "wrong")).rejects.toThrow(
			"Incorrect username or password",
		);
		expect(bodies[0]).toEqual({
			username: "reader",
			password: "secret-password",
		});
	});

	it("deletes the session to sign out", async () => {
		const fetch = vi.fn(
			async (request: Request) =>
				new Response(null, { status: request.method === "DELETE" ? 204 : 500 }),
		);
		vi.stubGlobal("fetch", fetch);
		await createBrowserSession("https://citadel.test").signOut();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("treats an unreachable server as an error, not a sign-out", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ code: "unavailable", message: "Busy" }, 503)),
		);
		await expect(
			createBrowserSession("https://citadel.test").current(),
		).rejects.toThrow("Busy");
	});
});
