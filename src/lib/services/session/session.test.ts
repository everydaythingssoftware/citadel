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
	administrator: false,
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

	it("reads the public setup status and creates the administrator with the code", async () => {
		const requests: Request[] = [];
		const bodies: unknown[] = [];
		const administrator = {
			user: { id: "user-2", username: "phil" },
			libraryAccess: false,
			administrator: true,
		};
		const responses = [
			json({
				administratorExists: false,
				libraryConfigured: false,
				libraryAvailable: false,
			}),
			json(
				{
					code: "unauthorized",
					message:
						"Incorrect setup code; it is printed where the server started",
				},
				401,
			),
			json(administrator),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				requests.push(request);
				if (request.method === "POST") bodies.push(await request.json());
				return responses.shift();
			}),
		);
		const service = createBrowserSession("https://citadel.test");
		expect(await service.setupStatus()).toEqual({
			administratorExists: false,
			libraryConfigured: false,
			libraryAvailable: false,
		});
		expect(requests[0]?.url).toBe("https://citadel.test/api/setup");
		await expect(
			service.createAdministrator("WRONG", "phil", "a long password"),
		).rejects.toThrow("Incorrect setup code");
		expect(
			await service.createAdministrator(
				"K7QD-M2XV-H9RW",
				"phil",
				"a long password",
			),
		).toEqual(administrator);
		expect(requests[2]?.url).toBe(
			"https://citadel.test/api/setup/administrator",
		);
		expect(bodies[1]).toEqual({
			setupCode: "K7QD-M2XV-H9RW",
			username: "phil",
			password: "a long password",
		});
	});
});
